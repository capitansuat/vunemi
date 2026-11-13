// The meetings Vunemi keeps on this Mac, as another assistant may read them.
// Reads only: nothing here writes, moves or removes a file.
import Foundation

typealias JSON = [String: Any]

/** What a tool could not do, said to the assistant that asked. */
struct ToolFailure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

struct Line {
    /** "me" is whoever recorded; "others" is everyone heard through the computer. */
    let source: String
    /** Seconds from the start of the recording. */
    let start: Double
    let end: Double
    let text: String
    /** Which of the others said it, once they were told apart. */
    let speaker: Int?
}

struct Meeting {
    let id: String
    let title: String
    /** Milliseconds since 1970, as Vunemi writes them. */
    let startedAt: Double
    let endedAt: Double?
    let language: String?
    let lines: [Line]
    /** The user's names for the others, by number; empty until they were told apart. */
    let speakers: [Int: String]
    let summary: String?
    let state: String

    init?(_ json: JSON) {
        guard let id = json["id"] as? String, Library.isMeetingID(id),
              let startedAt = json["startedAt"] as? Double,
              let state = json["state"] as? String else { return nil }
        self.id = id
        self.title = json["title"] as? String ?? ""
        self.startedAt = startedAt
        self.endedAt = json["endedAt"] as? Double
        self.language = json["language"] as? String
        self.summary = json["summary"] as? String
        self.state = state
        self.lines = (json["lines"] as? [JSON] ?? []).compactMap { line in
            guard let source = line["source"] as? String, let start = line["start"] as? Double,
                  let end = line["end"] as? Double, let text = line["text"] as? String else { return nil }
            return Line(source: source, start: start, end: end, text: text, speaker: line["speaker"] as? Int)
        }
        var names: [Int: String] = [:]
        for speaker in json["speakers"] as? [JSON] ?? [] {
            if let id = speaker["id"] as? Int { names[id] = speaker["name"] as? String ?? "" }
        }
        self.speakers = names
    }

    /** Who a line is from: the user's name for them, their number, or the side they were heard on. */
    func who(_ line: Line) -> String {
        if line.source == "me" { return "Me" }
        guard let speaker = line.speaker else { return "Others" }
        let name = speakers[speaker] ?? ""
        return name.isEmpty ? "Person \(speaker)" : name
    }
}

struct Library {
    /** Vunemi's data folder: settings.json and meetings/ are read from it. */
    let dataDir: URL
    var now: () -> Date = { Date() }

    /** A meeting.json larger than this is not one Vunemi wrote. */
    private static let maxBytes = 64 * 1024 * 1024
    /** The recorder appends audio all the time; a recording whose audio stopped growing was left by a crash. */
    private static let liveWithin: TimeInterval = 120

    /** A meeting's id, and its folder's name; anything else is never made into a path. */
    static func isMeetingID(_ id: String) -> Bool {
        id.count == 36 && id.allSatisfy { $0 == "-" || ($0.isHexDigit && !$0.isUppercase) }
    }

    /** The user's switch in Vunemi. Off, absent or unreadable all mean no. */
    var shared: Bool {
        guard let json = read(dataDir.appendingPathComponent("settings.json")) else { return false }
        return json["meetingsShared"] as? Bool == true
    }

    /** Every readable meeting, newest first. */
    func meetings() -> [Meeting] {
        let dir = dataDir.appendingPathComponent("meetings", isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter(Library.isMeetingID).compactMap(meeting).sorted { $0.startedAt > $1.startedAt }
    }

    func meeting(_ id: String) -> Meeting? {
        guard Library.isMeetingID(id),
              let json = read(folder(id).appendingPathComponent("meeting.json")) else { return nil }
        return Meeting(json)
    }

    /** Being recorded right now, not merely left in that state. */
    func isLive(_ meeting: Meeting) -> Bool {
        guard meeting.state == "recording" else { return false }
        let written = ["mic.pcm", "system.pcm"].compactMap { name -> Date? in
            let path = folder(meeting.id).appendingPathComponent(name).path
            return (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        }
        guard let latest = written.max() else { return false }
        return now().timeIntervalSince(latest) <= Library.liveWithin
    }

    /** The meeting a tool means: the one named, else the one being recorded, else the latest. */
    func resolve(_ id: String?) throws -> Meeting {
        if let id {
            guard let found = meeting(id) else { throw ToolFailure("No meeting has that id. list_recent_meetings gives the ids.") }
            return found
        }
        let all = meetings()
        guard let latest = all.first(where: isLive) ?? all.first else { throw ToolFailure("There are no meetings in Vunemi yet.") }
        return latest
    }

    private func folder(_ id: String) -> URL {
        dataDir.appendingPathComponent("meetings", isDirectory: true).appendingPathComponent(id, isDirectory: true)
    }

    private func read(_ file: URL) -> JSON? {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int,
              size <= Library.maxBytes, let data = try? Data(contentsOf: file) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? JSON
    }
}
