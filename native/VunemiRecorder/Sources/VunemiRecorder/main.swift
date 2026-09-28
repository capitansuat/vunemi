// VunemiRecorder — records a meeting the user started, and nothing else.
//
// Two sources, each to its own file as 16 kHz mono signed 16-bit PCM: the
// Mac's system audio (the other people in the call) through a Core Audio
// process tap, and the microphone (the user) with Apple's voice processing,
// so the far side coming out of the speakers is not recorded again as the
// user. The app reads the files as they grow and writes the meeting down.
//
// Kept apart from VunemiHelper on purpose: a new helper signature asks for
// the Vault key again and has cost it its Accessibility permission before.
// Like the helper it holds no policy; it records while asked and stops when
// told, or when Vunemi goes away (end of stdin).

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

// MARK: - Protocol

typealias JSON = [String: Any]

struct Failure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

func write(_ object: JSON) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func respond(id: Any?, result: Any) { write(["id": id ?? NSNull(), "ok": true, "result": result]) }
func fail(id: Any?, _ message: String) { write(["id": id ?? NSNull(), "ok": false, "error": message]) }

func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw Failure("\(what) failed (\(status))") }
}

// MARK: - Writing a source

/// What every source is written as.
let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

/// One file of 16 kHz mono PCM, converted and written off the audio thread.
final class Sink {
    private let queue: DispatchQueue
    private let handle: FileHandle
    private var pending = Data()
    private var converter: AVAudioConverter?
    private var converting: AVAudioFormat?
    private var level: Float = 0
    private var written = 0
    /** Any sample that is not exactly zero. A live microphone never gives pure zeros; a muted one does. */
    private var heard = false
    private let timer: DispatchSourceTimer

    init(path: String, label: String) throws {
        queue = DispatchQueue(label: "sink.\(label)")
        guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]),
              let handle = FileHandle(forWritingAtPath: path) else {
            throw Failure("Cannot write \(label) audio.")
        }
        self.handle = handle
        timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in self?.flush() }
        timer.resume()
    }

    /// Copies the samples at once: the buffer belongs to the audio system.
    func append(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
        copy.frameLength = buffer.frameLength
        let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (source, destination) in zip(from, to) {
            guard let src = source.mData, let dst = destination.mData else { continue }
            memcpy(dst, src, Int(min(source.mDataByteSize, destination.mDataByteSize)))
        }
        queue.async { self.convert(copy) }
    }

    private func convert(_ input: AVAudioPCMBuffer) {
        if converter == nil || converting != input.format {
            converter = AVAudioConverter(from: input.format, to: target)
            converter?.downmix = true
            converting = input.format
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(input.frameLength) * target.sampleRate / input.format.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var given = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return input
        }
        let count = Int(output.frameLength)
        guard count > 0, let samples = output.int16ChannelData?[0] else { return }
        pending.append(UnsafeBufferPointer(start: samples, count: count))
        var sum: Float = 0
        for i in 0..<count {
            let x = Float(samples[i]) / 32768
            sum += x * x
        }
        level = (sum / Float(count)).squareRoot()
        if !heard { heard = sum > 0 }
        written += count
    }

    private func flush() {
        guard !pending.isEmpty else { return }
        handle.write(pending)
        pending.removeAll(keepingCapacity: true)
    }

    var state: (level: Float, seconds: Double, heard: Bool) {
        queue.sync { (level, Double(written) / target.sampleRate, heard) }
    }

    func close() {
        queue.sync {
            timer.cancel()
            flush()
            try? handle.close()
        }
    }
}

// MARK: - System audio

/// Everything the Mac plays, through a private global tap (macOS 14.2+).
@available(macOS 14.2, *)
final class SystemCapture {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?

    init(sink: Sink) throws {
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Vunemi meeting"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tap), "System audio tap")

        // Only the tap: adding the output device as well recorded everything twice.
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Vunemi meeting",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        do {
            try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "System audio device")
            var format = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "System audio format")
            guard let avFormat = AVAudioFormat(streamDescription: &format) else { throw Failure("System audio format is not readable.") }
            let queue = DispatchQueue(label: "tap", qos: .userInitiated)
            try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, queue) { _, input, _, _, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: avFormat, bufferListNoCopy: input, deallocator: nil) else { return }
                sink.append(buffer)
            }, "System audio reader")
            try check(AudioDeviceStart(device, proc), "System audio start")
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        if let proc {
            AudioDeviceStop(device, proc)
            AudioDeviceDestroyIOProcID(device, proc)
            self.proc = nil
        }
        if device != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(device)
            device = AudioObjectID(kAudioObjectUnknown)
        }
        if tap != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tap)
            tap = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

// MARK: - Microphone

/// The user's voice, with echo cancellation and the other audio left at full volume.
final class MicCapture {
    private var engine = AVAudioEngine()
    private let sink: Sink
    private let uid: String?
    private(set) var voiceProcessing: Bool

    init(sink: Sink, device uid: String?) throws {
        self.sink = sink
        self.uid = uid
        voiceProcessing = true
        try run()
    }

    private func run() throws {
        let input = engine.inputNode
        if let uid, var id = inputDevices().first(where: { $0.uid == uid })?.id, let unit = input.audioUnit {
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)), "Microphone choice")
        }
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            // Voice processing turns other audio down by default; the meeting must stay audible.
            input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            // It is one unit for input and output: with no output running the
            // input stayed silent. The mixer has nothing to play; it only runs it.
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
            engine.mainMixerNode.outputVolume = 0
        }
        let format = input.outputFormat(forBus: 0)
        let sink = self.sink
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in sink.append(buffer) }
        engine.prepare()
        try engine.start()
    }

    /** Voice processing gave only silence: the plain microphone, without echo cancellation. */
    func withoutVoiceProcessing() throws {
        guard voiceProcessing else { return }
        stop()
        voiceProcessing = false
        engine = AVAudioEngine()
        try run()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// MARK: - Devices

struct InputDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

func text(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    guard status == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

func inputDevices() -> [InputDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
        guard let uid = text(id, kAudioDevicePropertyDeviceUID), let name = text(id, kAudioObjectPropertyName) else { return nil }
        // Private aggregate devices, ours included, are not microphones.
        if uid.hasPrefix("CADefaultDeviceAggregate") || name == "Vunemi meeting" { return nil }
        return InputDevice(id: id, uid: uid, name: name)
    }
}

func defaultInput() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr ? id : nil
}

// MARK: - Recording

final class Recording {
    private let others: Sink
    private let me: Sink
    private let system: AnyObject
    private let mic: MicCapture
    /** Microphone changes happen here, one at a time. */
    private let control = DispatchQueue(label: "control")
    private var stopped = false

    init(dir: String, microphone: String?) throws {
        guard #available(macOS 14.2, *) else { throw Failure("macos") }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                granted = ok
                semaphore.signal()
            }
            semaphore.wait()
            guard granted else { throw Failure("microphone") }
        default: throw Failure("microphone")
        }
        others = try Sink(path: (dir as NSString).appendingPathComponent("system.pcm"), label: "system")
        me = try Sink(path: (dir as NSString).appendingPathComponent("mic.pcm"), label: "mic")
        let system = try SystemCapture(sink: others)
        do {
            mic = try MicCapture(sink: me, device: microphone)
        } catch {
            system.stop()
            throw error
        }
        self.system = system
        watch()
    }

    var levels: JSON {
        control.sync { ["me": Double(me.state.level), "others": Double(others.state.level), "echoCancellation": mic.voiceProcessing] }
    }

    /** After a moment: a microphone that has given only exact zeros is tried again without voice processing. */
    private func watch() {
        control.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, !self.stopped, !self.me.state.heard else { return }
            do {
                try self.mic.withoutVoiceProcessing()
                FileHandle.standardError.write(Data("microphone silent with voice processing; recording without it\n".utf8))
            } catch {
                FileHandle.standardError.write(Data("microphone restart failed: \(error)\n".utf8))
            }
        }
    }

    func stop() -> Double {
        control.sync {
            stopped = true
            mic.stop()
        }
        if #available(macOS 14.2, *) { (system as? SystemCapture)?.stop() }
        me.close()
        others.close()
        return max(me.state.seconds, others.state.seconds)
    }
}

var recording: Recording?

func handle(_ request: JSON) {
    let id = request["id"]
    let op = request["op"] as? String ?? ""
    let args = request["args"] as? JSON ?? [:]
    do {
        switch op {
        case "ping":
            respond(id: id, result: ["version": 1])
        case "devices":
            let fallback = defaultInput()
            respond(id: id, result: ["microphones": inputDevices().map { ["id": $0.uid, "name": $0.name, "default": $0.id == fallback] }])
        case "start":
            guard recording == nil else { throw Failure("A meeting is already being recorded.") }
            guard let dir = args["dir"] as? String, dir.hasPrefix("/") else { throw Failure("No meeting folder.") }
            recording = try Recording(dir: dir, microphone: args["microphone"] as? String)
            respond(id: id, result: ["started": true])
        case "levels":
            respond(id: id, result: recording?.levels ?? ["me": 0.0, "others": 0.0])
        case "stop":
            let seconds = recording?.stop() ?? 0
            recording = nil
            respond(id: id, result: ["stopped": true, "seconds": seconds])
        default:
            throw Failure("Unknown request: \(op)")
        }
    } catch let failure as Failure {
        fail(id: id, failure.message)
    } catch {
        fail(id: id, "\(error)")
    }
}

// MARK: - Loop

setbuf(stdout, nil)
while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? JSON else {
        fail(id: nil, "Unreadable request.")
        continue
    }
    handle(request)
}
// Vunemi went away: whatever was recorded is kept.
_ = recording?.stop()
