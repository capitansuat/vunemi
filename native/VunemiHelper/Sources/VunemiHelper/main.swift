// VunemiHelper — the part of Vunemi that macOS will actually talk to.
//
// Electron cannot read the accessibility tree or synthesise input; those are
// Swift APIs behind TCC. So this small executable does exactly that and
// nothing else, speaking one JSON object per line over stdin/stdout. It holds
// no policy: it refuses nothing, decides nothing, and every call it serves was
// already approved on the TypeScript side. Keeping it that dumb is the point —
// the process with the dangerous privileges should be the one with no opinions.
//
// Permissions are probed on every call that needs them, never cached: macOS
// hands them out and takes them away while an app is running, and a cached
// "granted" is how an agent ends up silently doing nothing.

import AppKit
import ApplicationServices
import EventKit
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - Protocol

typealias JSON = [String: Any]

/// One line in, one line out. Anything unexpected is an error, not a crash.
func respond(id: Any?, result: Any) {
    write(["id": id ?? NSNull(), "ok": true, "result": result])
}

func fail(id: Any?, _ message: String) {
    write(["id": id ?? NSNull(), "ok": false, "error": message])
}

func write(_ object: JSON) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

// MARK: - Permissions

/// Asked fresh every time. `prompt` shows the system dialog once per app.
func accessibilityTrusted(prompt: Bool) -> Bool {
    // The constant itself is a mutable global in the C headers; its value is
    // this string and has been for a decade.
    let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

/// The honest probe.
///
/// `AXIsProcessTrusted` answers a question about the *responsible* process,
/// which for a helper spawned by an app is not necessarily this one — it
/// cheerfully returns true while every real call comes back empty. So we also
/// try to read something that always exists (the front app's windows) and
/// report what macOS actually said. A permission that doesn't work is not a
/// permission, and an agent that pretends otherwise just does nothing quietly.
func axWorks() -> (ok: Bool, detail: String) {
    // The frontmost app can be Vunemi itself, System Settings, or an app that
    // does not answer AX. A failed request to that one app is not proof that
    // the helper lacks Accessibility permission. Try another regular app.
    let workspace = NSWorkspace.shared
    let candidates = ([workspace.frontmostApplication].compactMap { $0 } + currentApps())
        .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    var seen = Set<pid_t>()
    var lastError = "yanıt veren uygulama yok"
    for app in candidates.prefix(6) where seen.insert(app.processIdentifier).inserted {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.5)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, "AXWindows" as CFString, &value)
        if error == .success { return (true, "tamam") }
        if error == .apiDisabled { return (false, "erişilebilirlik kapalı (apiDisabled)") }
        lastError = "\(app.localizedName ?? "uygulama"): AXError \(error.rawValue)"
    }
    return (false, lastError)
}

func permissions(prompt: Bool) -> JSON {
    let trusted = accessibilityTrusted(prompt: prompt)
    let probe = axWorks()
    return [
        // Both have to be true: the flag, and a call that actually returns.
        "accessibility": trusted && probe.ok,
        "trusted": trusted,
        "probe": probe.detail,
        "screenRecording": CGPreflightScreenCaptureAccess(),
        // Separate grants, asked separately: a user who lets Vunemi read the
        // screen has not thereby let it read their calendar.
        "calendars": calendarGranted(.event),
        "reminders": calendarGranted(.reminder),
    ]
}

// MARK: - Applications

// NSWorkspace refreshes runningApplications only when the main run loop runs.
// readLine blocks that loop between requests, so process pending launch and
// termination notifications before every lookup.
func currentApps() -> [NSRunningApplication] {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

func runningApps() -> [JSON] {
    currentApps()
        .map { app in
            [
                "name": app.localizedName ?? "",
                "bundleId": app.bundleIdentifier ?? "",
                "pid": Int(app.processIdentifier),
                "frontmost": app.isActive,
            ] as JSON
        }
        .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
}

func app(matching id: String) -> NSRunningApplication? {
    let apps = currentApps()
    if let pid = Int32(id) { return apps.first { $0.processIdentifier == pid } }
    let wanted = id.lowercased()
    return apps.first { ($0.bundleIdentifier ?? "").lowercased() == wanted }
        ?? apps.first { ($0.localizedName ?? "").lowercased() == wanted }
        ?? apps.first { ($0.localizedName ?? "").lowercased().contains(wanted) }
}

// MARK: - Accessibility tree

/// Roles worth a line of a small model's context even with no name. Written
/// out rather than taken from the AX constants, which are mutable globals.
let interactiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
    "AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor",
    "AXLink", "AXMenuItem", "AXTabGroup", "AXDisclosureTriangle", "AXSegmentedControl",
]

/// Containers that carry no meaning of their own; we walk through them.
let skeletonRoles: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown"]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let text = value as? String { return text.isEmpty ? nil : text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, "AXChildren") as? [AXUIElement]) ?? []
}

func point(_ element: AXUIElement) -> CGPoint? {
    guard let value = attribute(element, "AXPosition"),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    AXValueGetValue(value as! AXValue, .cgPoint, &origin)
    return origin
}

func size(_ element: AXUIElement) -> CGSize? {
    guard let value = attribute(element, "AXSize"),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var box = CGSize.zero
    AXValueGetValue(value as! AXValue, .cgSize, &box)
    return box
}

/// Where a click on this element should land.
func centre(_ element: AXUIElement) -> CGPoint? {
    guard let origin = point(element), let box = size(element), box.width > 0, box.height > 0 else { return nil }
    return CGPoint(x: origin.x + box.width / 2, y: origin.y + box.height / 2)
}

/// The elements a click can reach, numbered, with one line each.
final class Tree {
    private(set) var lines: [String] = []
    private(set) var elements: [Int: AXUIElement] = [:]
    private var next = 1
    private let limit: Int

    init(limit: Int = 400) { self.limit = limit }

    func build(from root: AXUIElement, depth: Int = 0, maxDepth: Int = 18) {
        guard lines.count < limit, depth < maxDepth else { return }
        for child in children(root) {
            guard lines.count < limit else { return }
            let role = (string(child, "AXRole") ?? "AXUnknown")
                .replacingOccurrences(of: "AX", with: "")
            let name = string(child, "AXTitle")
                ?? string(child, "AXDescription")
                ?? string(child, "AXValue")

            let interactive = interactiveRoles.contains("AX" + role)
            let worthShowing = interactive || (name != nil && !skeletonRoles.contains("AX" + role))

            if worthShowing, let name, !name.isEmpty || interactive {
                let ref = next
                next += 1
                elements[ref] = child
                let indent = String(repeating: "  ", count: min(depth, 6))
                let enabled = (attribute(child, "AXEnabled") as? Bool) ?? true
                let short = name.count > 120 ? String(name.prefix(119)) + "…" : name
                lines.append("\(indent)[\(ref)] \(role) \"\(short)\"\(enabled ? "" : " (kapalı)")")
                build(from: child, depth: depth + 1, maxDepth: maxDepth)
            } else {
                // A skeleton container: walk through it without spending a line.
                build(from: child, depth: depth, maxDepth: maxDepth)
            }
        }
    }
}

/// The last tree per pid, so clicks can name a ref and diffs have something to
/// compare against. Single-threaded by construction: one blocking read loop,
/// one request at a time, which is why these are `nonisolated(unsafe)`.
nonisolated(unsafe) var trees: [Int32: Tree] = [:]
nonisolated(unsafe) var snapshots: [Int32: [String]] = [:]

/// How many windows the window server sees for this app, whatever the
/// accessibility tree says. No Screen Recording needed for the count — only
/// for the titles, which we don't ask for.
func windowCount(pid: Int32) -> Int {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return 0 }
    return list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.count
}

/// The app's window, if it has one it will admit to. Many apps only publish
/// their accessibility tree once they are active, so a refusal is worth one
/// activation and a second look before it is reported as "no window".
func windowElement(of appElement: AXUIElement) -> AXUIElement? {
    if let focused = attribute(appElement, "AXFocusedWindow") { return (focused as! AXUIElement) }
    if let main = attribute(appElement, "AXMainWindow") { return (main as! AXUIElement) }
    if let windows = attribute(appElement, "AXWindows") as? [AXUIElement], let first = windows.first { return first }
    return nil
}

func describe(pid: Int32, part: String) throws -> JSON {
    guard accessibilityTrusted(prompt: false) else {
        throw Failure("Erişilebilirlik izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik.")
    }
    let appElement = AXUIElementCreateApplication(pid)
    let root: AXUIElement
    switch part {
    case "menu":
        // The menu bar is where a Mac app keeps the commands that have no
        // button, and it is worth asking for on purpose — never by accident,
        // because it alone is hundreds of lines.
        guard let bar = attribute(appElement, "AXMenuBar") else {
            throw Failure("Bu uygulamanın menü çubuğu okunamıyor.")
        }
        root = bar as! AXUIElement
    default:
        var found = windowElement(of: appElement)
        if found == nil, let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
            // Bring it forward and ask again: for a lot of apps that is the
            // difference between an empty tree and the whole window.
            app.activate()
            usleep(500_000)
            found = windowElement(of: appElement)
        }
        if let found {
            root = found
        } else {
            // Tell the two apart: an app with no window, and an app we are not
            // allowed to see into. They look identical from here otherwise.
            let probe = axWorks()
            let onScreen = windowCount(pid: pid)
            if !probe.ok {
                throw Failure(
                    "Pencere okunamadı — \(probe.detail). Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik'te Vunemi'nin (geliştirmede: Electron) işaretli olması ve uygulamanın yeniden başlatılması gerekiyor."
                )
            }
            if onScreen > 0 {
                throw Failure(
                    "macOS bu uygulamanın \(onScreen) penceresini görüyor ama uygulama erişilebilirlik ağacında pencere yayınlamıyor. Menüsü için part=\"menu\" kullanılabilir; pencereye kullanıcının kendisi bakmalı."
                )
            }
            throw Failure("Bu uygulama açık ama penceresi yok (hepsi kapatılmış olabilir). Menüsü için part=\"menu\" kullan.")
        }
    }
    let tree = Tree()
    tree.build(from: root)
    trees[pid] = tree
    let previous = snapshots[pid]
    snapshots[pid] = tree.lines
    return [
        "text": tree.lines.joined(separator: "\n"),
        "count": tree.lines.count,
        "changed": previous.map { diff(from: $0, to: tree.lines) } ?? NSNull(),
    ]
}

/// A plain-text diff: what appeared, what went. The whole tree is ~180 KB;
/// this is a few hundred bytes, and it answers "did that click work?".
func diff(from old: [String], to new: [String]) -> String {
    let before = Set(old.map(stripRef))
    let after = Set(new.map(stripRef))
    let added = new.filter { !before.contains(stripRef($0)) }
    let removed = old.filter { !after.contains(stripRef($0)) }
    var out: [String] = []
    out.append(contentsOf: added.prefix(40).map { "+ " + $0.trimmingCharacters(in: .whitespaces) })
    out.append(contentsOf: removed.prefix(40).map { "- " + $0.trimmingCharacters(in: .whitespaces) })
    return out.isEmpty ? "(değişiklik yok)" : out.joined(separator: "\n")
}

/// Ref numbers change every snapshot; the text is what identifies a line.
func stripRef(_ line: String) -> String {
    guard let close = line.firstIndex(of: "]") else { return line }
    return String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces)
}

// MARK: - Pictures

/// Screenshots go through ScreenCaptureKit. The old
/// `CGWindowListCreateImage` is not used on purpose: on macOS 26 it stalls
/// for ~30 seconds on multi-display Macs, which for an agent looks exactly
/// like a hang.
///
/// Images are scaled down on the way out: a grounding model works in a
/// 1024-wide space anyway, and a full Retina window is megabytes of nothing.
func capture(pid: Int32, to path: String) throws -> JSON {
    guard CGPreflightScreenCaptureAccess() else {
        throw Failure("Ekran kaydı izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı.")
    }

    /// The capture is async and this loop is not; the semaphore is the join,
    /// and it is also what makes the sharing safe — nobody reads the box until
    /// the task has finished writing it.
    final class Box: @unchecked Sendable {
        var image: CGImage?
        var failure: Error?
    }
    let box = Box()
    let semaphore = DispatchSemaphore(value: 0)

    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = content.windows
                .filter({ $0.owningApplication?.processID == pid && $0.frame.width > 80 && $0.frame.height > 80 })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            else {
                throw Failure("Bu uygulamanın ekranda görünen bir penceresi yok.")
            }
            let config = SCStreamConfiguration()
            let scale = min(1.0, 1024 / max(window.frame.width, 1))
            config.width = Int(window.frame.width * scale)
            config.height = Int(window.frame.height * scale)
            config.showsCursor = false
            let filter = SCContentFilter(desktopIndependentWindow: window)
            box.image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            box.failure = error
        }
        semaphore.signal()
    }
    semaphore.wait()

    if let failure = box.failure { throw failure }
    guard let image = box.image else { throw Failure("Ekran görüntüsü alınamadı.") }

    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw Failure("Görüntü yazılamadı.")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw Failure("Görüntü kaydedilemedi.") }
    return ["path": path, "width": image.width, "height": image.height]
}

// MARK: - Input

struct Failure: Error { let message: String; init(_ m: String) { message = m } }

func clickPoint(_ where_: CGPoint, double: Bool) {
    let source = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: where_, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: where_, mouseButton: .left)
    if double {
        down?.setIntegerValueField(.mouseEventClickState, value: 2)
        up?.setIntegerValueField(.mouseEventClickState, value: 2)
    }
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: where_, mouseButton: .left)?.post(tap: .cghidEventTap)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    if double {
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}

func typeText(_ text: String) {
    let source = CGEventSource(stateID: .combinedSessionState)
    // In chunks: the event system drops very long strings.
    for chunk in stride(from: 0, to: Array(text.utf16).count, by: 20) {
        let units = Array(Array(text.utf16)[chunk..<min(chunk + 20, Array(text.utf16).count)])
        for pressed in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: pressed) else { continue }
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.post(tap: .cghidEventTap)
        }
        usleep(8000)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3, "n": 45, "w": 13, "t": 17, "l": 37,
]

func pressKey(_ combo: String) throws {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.last, let code = keyCodes[last] else {
        throw Failure("\"\(combo)\" tuşu tanınmıyor.")
    }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: throw Failure("\"\(modifier)\" diye bir değiştirici tuş yok.")
        }
    }
    let source = CGEventSource(stateID: .combinedSessionState)
    for pressed in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: pressed)
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
    }
}

// MARK: - Dispatch

func handle(_ request: JSON) {
    let id = request["id"]
    let op = request["op"] as? String ?? ""
    let args = request["args"] as? JSON ?? [:]

    do {
        switch op {
        case "ping":
            respond(id: id, result: ["version": 1])

        case "permissions":
            respond(id: id, result: permissions(prompt: args["prompt"] as? Bool ?? false))

        case "apps":
            respond(id: id, result: ["apps": runningApps()])

        case "focus":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("\"\(args["app"] as? String ?? "")\" diye açık bir uygulama yok.")
            }
            found.activate()
            usleep(250_000)
            respond(id: id, result: ["name": found.localizedName ?? "", "pid": Int(found.processIdentifier)])

        case "describe":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("\"\(args["app"] as? String ?? "")\" diye açık bir uygulama yok.")
            }
            var result = try describe(pid: found.processIdentifier, part: args["part"] as? String ?? "window")
            result["app"] = found.localizedName ?? ""
            result["pid"] = Int(found.processIdentifier)
            respond(id: id, result: result)

        case "click", "doubleclick":
            guard accessibilityTrusted(prompt: false) else {
                throw Failure("Erişilebilirlik izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik.")
            }
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("Uygulama bulunamadı.")
            }
            guard let ref = args["ref"] as? Int, let element = trees[found.processIdentifier]?.elements[ref] else {
                throw Failure("[\(args["ref"] as? Int ?? -1)] diye bir öğe yok. Önce describe çağır.")
            }
            guard let spot = centre(element) else { throw Failure("Bu öğenin ekranda bir yeri yok.") }
            found.activate()
            usleep(150_000)
            clickPoint(spot, double: op == "doubleclick")
            usleep(250_000)
            respond(id: id, result: ["x": spot.x, "y": spot.y])

        case "type":
            guard accessibilityTrusted(prompt: false) else {
                throw Failure("Erişilebilirlik izni yok.")
            }
            guard let text = args["text"] as? String, !text.isEmpty else { throw Failure("Yazılacak bir metin gerekiyor.") }
            typeText(text)
            respond(id: id, result: ["typed": text.count])

        case "screenshot":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("Uygulama bulunamadı.")
            }
            guard let path = args["path"] as? String, !path.isEmpty else {
                throw Failure("Görüntünün yazılacağı bir yol gerekiyor.")
            }
            found.activate()
            usleep(250_000)
            var shot = try capture(pid: found.processIdentifier, to: path)
            shot["app"] = found.localizedName ?? ""
            respond(id: id, result: shot)

        case "request_screen_recording":
            // Shows the system dialog once; after that the user has to do it
            // in System Settings, and the app has to be restarted.
            respond(id: id, result: ["asked": CGRequestScreenCaptureAccess()])

        case "key":
            guard accessibilityTrusted(prompt: false) else { throw Failure("Erişilebilirlik izni yok.") }
            try pressKey(args["combo"] as? String ?? "")
            respond(id: id, result: ["pressed": args["combo"] as? String ?? ""])

        // -- calendar and reminders ------------------------------------------

        case "request_calendar":
            let entity: EKEntityType = args["kind"] as? String == "reminder" ? .reminder : .event
            let granted = try requestCalendarAccess(entity)
            // The state afterwards is the difference between "the user said
            // no" and "macOS never asked them" — which are different
            // problems with different fixes, and look identical from here
            // without it.
            respond(id: id, result: ["granted": granted, "state": calendarState(entity)])

        case "calendars":
            let entity: EKEntityType = args["kind"] as? String == "reminder" ? .reminder : .event
            respond(id: id, result: ["calendars": try calendarList(entity)])

        case "events":
            let start = try date(args["start"], "Başlangıç")
            let end = try date(args["end"], "Bitiş")
            guard end > start else { throw Failure("Bitiş, başlangıçtan sonra olmalı.") }
            let named = args["calendars"] as? [String]
            respond(id: id, result: ["events": try events(from: start, to: end, calendars: named)])

        case "event_create":
            guard let title = (args["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty
            else { throw Failure("Etkinliğin bir başlığı olmalı.") }
            let start = try date(args["start"], "Başlangıç")
            let end = try date(args["end"], "Bitiş")
            guard end > start else { throw Failure("Bitiş, başlangıçtan sonra olmalı.") }
            respond(
                id: id,
                result: try createEvent(
                    title: title, start: start, end: end, allDay: args["allDay"] as? Bool ?? false,
                    calendar: args["calendar"] as? String, notes: args["notes"] as? String,
                    location: args["location"] as? String))

        case "event_get":
            guard let eventId = args["id"] as? String, !eventId.isEmpty else { throw Failure("Etkinlik kimliği gerekiyor.") }
            respond(id: id, result: try event(id: eventId))

        case "event_delete":
            guard let eventId = args["id"] as? String, !eventId.isEmpty else { throw Failure("Etkinlik kimliği gerekiyor.") }
            respond(id: id, result: try deleteEvent(id: eventId))

        case "event_update":
            guard let eventId = args["id"] as? String, !eventId.isEmpty else { throw Failure("Etkinlik kimliği gerekiyor.") }
            respond(id: id, result: try updateEvent(id: eventId, fields: args))

        case "event_remove":
            guard let eventId = args["id"] as? String, !eventId.isEmpty else { throw Failure("Etkinlik kimliği gerekiyor.") }
            try removeEvent(id: eventId)
            respond(id: id, result: ["removed": eventId])

        case "reminders":
            respond(
                id: id,
                result: [
                    "reminders": try reminders(
                        list: args["list"] as? String, includeCompleted: args["includeCompleted"] as? Bool ?? false)
                ])

        case "reminder_create":
            guard let title = (args["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty
            else { throw Failure("Anımsatıcının bir başlığı olmalı.") }
            let dueText = args["due"] as? String
            respond(
                id: id,
                result: try createReminder(
                    title: title, due: dueText.flatMap(parseDate), list: args["list"] as? String,
                    notes: args["notes"] as? String))

        case "reminder_complete":
            guard let itemId = args["id"] as? String, !itemId.isEmpty else { throw Failure("Anımsatıcı kimliği gerekiyor.") }
            respond(id: id, result: try setReminderCompleted(id: itemId, completed: args["completed"] as? Bool ?? true))

        case "reminder_get":
            guard let itemId = args["id"] as? String, !itemId.isEmpty else { throw Failure("Anımsatıcı kimliği gerekiyor.") }
            respond(id: id, result: try reminderDetail(id: itemId))

        case "reminder_update":
            guard let itemId = args["id"] as? String, !itemId.isEmpty else { throw Failure("Anımsatıcı kimliği gerekiyor.") }
            respond(id: id, result: try updateReminder(id: itemId, fields: args))

        case "reminder_delete":
            guard let itemId = args["id"] as? String, !itemId.isEmpty else { throw Failure("Anımsatıcı kimliği gerekiyor.") }
            respond(id: id, result: try deleteReminder(id: itemId))

        case "reminder_remove":
            guard let itemId = args["id"] as? String, !itemId.isEmpty else { throw Failure("Anımsatıcı kimliği gerekiyor.") }
            try removeReminder(id: itemId)
            respond(id: id, result: ["removed": itemId])

        case "authenticate":
            respond(id: id, result: authenticateOwner(reason: args["reason"] as? String ?? "unlock Vunemi"))

        case "vault_key":
            // Only to Vunemi itself: any program of this user can start this helper.
            guard callerIsVunemi() else { throw Failure("Kasa anahtarı yalnız Vunemi'ye verilir.") }
            // create=false only looks; the app asks to create on first run.
            respond(id: id, result: try vaultKey(create: args["create"] as? Bool ?? false))

        case "caller_check":
            // Whether vault_key would answer this caller; the key itself isn't touched.
            respond(id: id, result: ["vunemi": callerIsVunemi()])

        default:
            throw Failure("Bilinmeyen işlem: \(op)")
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
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? JSON else {
        fail(id: nil, "Okunamayan istek.")
        continue
    }
    handle(request)
}
