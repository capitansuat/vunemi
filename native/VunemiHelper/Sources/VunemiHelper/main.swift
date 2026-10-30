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

// Headless admission exits before AX, EventKit or desktop actions.
exitForJournalLockModeIfRequested()

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
    "AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor", "AXScrollBar",
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
    private(set) var labels: [Int:String] = [:]
    private(set) var inputValues:[String] = []
    private var next = 1
    private let limit: Int

    init(limit: Int = 400) { self.limit = limit }

    func build(from root: AXUIElement, depth: Int = 0, maxDepth: Int = 18) {
        guard lines.count < limit, depth < maxDepth else { return }
        for child in children(root) {
            guard lines.count < limit else { return }
            let role = (string(child, "AXRole") ?? "AXUnknown")
                .replacingOccurrences(of: "AX", with: "")
            let name = ["StaticText","TextField","TextArea","ComboBox"].contains(role)
                ? elementLabel(title:string(child,"AXTitle"),description:string(child,"AXDescription"),value:string(child,"AXValue"))
                : string(child, "AXTitle") ?? string(child, "AXDescription") ?? string(child, "AXValue")

            if ["StaticText","TextField","TextArea","ComboBox"].contains(role), let value=string(child,"AXValue") { inputValues.append(value) }
            let interactive = interactiveRoles.contains("AX" + role)
            let worthShowing = interactive || (name != nil && !skeletonRoles.contains("AX" + role))

            if worthShowing, let name, !name.isEmpty || interactive {
                let ref = next
                next += 1
                elements[ref] = child
                let indent = String(repeating: "  ", count: min(depth, 6))
                let enabled = (attribute(child, "AXEnabled") as? Bool) ?? true
                let short = name.count > 120 ? String(name.prefix(119)) + "…" : name
                labels[ref]=short
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
struct Observation {
    let id: String, pid: Int32, bundleId: String, launch: Date?, part: String
    let window: WindowCandidate, root: AXUIElement, tree: Tree, at: Date
    let layout: [Int:String], focused: AXUIElement?
    let background: Bool
    let sliders:[Int:SliderDragState]
    var json: JSON { ["snapshotId":id,"windowId":Int(window.id),"windowTitle":window.title,"pid":Int(pid),"bundleId":bundleId,"processStartedAt":launch?.timeIntervalSince1970 ?? 0,"part":part,"observedAt":at.timeIntervalSince1970,"bounds":window.bounds.json,"coordinateFrame":"screen-points-top-left"] }
}
nonisolated(unsafe) var observations: [String: Observation] = [:]
nonisolated(unsafe) var latestObservation: [String: String] = [:]
func treeLayout(_ tree: Tree) -> [Int:String] {
    tree.elements.mapValues { element in
        guard let p=point(element), let z=size(element) else { return "unpositioned" }
        return "\(p.x),\(p.y),\(z.width),\(z.height)"
    }
}
// NSRunningApplication.isActive is cached until the main run loop advances.
// This helper has a blocking JSONL loop, so input delivery uses a fresh AX
// system-wide observation rather than that cached property.
func focusedApplicationPID() -> Int32? {
    RunLoop.main.run(until:Date(timeIntervalSinceNow:0.01))
    let front=NSWorkspace.shared.frontmostApplication
    var ax:Int32?
    if let value=attribute(AXUIElementCreateSystemWide(),"AXFocusedApplication"),CFGetTypeID(value)==AXUIElementGetTypeID() {
        var pid:Int32=0
        if AXUIElementGetPid(value as! AXUIElement,&pid) == .success {ax=pid}
    }
    return verifiedForegroundPID(ax:ax,workspace:front?.processIdentifier,workspaceActive:front?.isActive == true)
}
// A background helper cannot rely on an activation request being honoured.
// Accessibility may request the exact app's foreground state; actual focus is
// still independently checked before any input and snapshot validation repeats.
func requestTargetFocus(_ app:NSRunningApplication, window:AXUIElement? = nil) {
    app.activate(options:[])
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), "AXFrontmost" as CFString, kCFBooleanTrue)
    if let window { AXUIElementPerformAction(window,"AXRaise" as CFString) }
}
func waitForFocus(pid:Int32, window:AXUIElement? = nil) -> Bool {
    let deadline=Date().addingTimeInterval(0.75)
    repeat {
        if focusedApplicationPID()==pid {
            if window==nil { return true }
            if let focused=attribute(AXUIElementCreateApplication(pid),"AXFocusedWindow"), CFEqual(focused,window!) { return true }
        }
        RunLoop.current.run(until:Date().addingTimeInterval(0.025))
    } while Date()<deadline
    return false
}
func focusedElement(_ pid:Int32) -> AXUIElement? {
    guard let element=attribute(AXUIElementCreateApplication(pid),"AXFocusedUIElement"), CFGetTypeID(element)==AXUIElementGetTypeID() else { return nil }
    return element as! AXUIElement
}
func checkBackgroundSession() throws {
    let session=CGSessionCopyCurrentDictionary() as? [String:Any]
    try requireBackgroundSession(onConsole:session?["kCGSSessionOnConsoleKey"] as? Bool,
        locked:session == nil ? nil : (session?["CGSSessionScreenIsLocked"] as? Bool ?? false))
}
func observationKey(_ pid: Int32, _ part: String, _ window: UInt32) -> String { "\(pid):\(part):\(window)" }
func visibleWindows(pid: Int32) -> [WindowCandidate] {
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] else { return [] }
    return rows.compactMap { row in
        guard let owner = row[kCGWindowOwnerPID as String] as? Int32, owner == pid,
            let id = row[kCGWindowNumber as String] as? UInt32,
            let bounds = row[kCGWindowBounds as String] as? [String:Double],
            let x=bounds["X"], let y=bounds["Y"], let w=bounds["Width"], let h=bounds["Height"], w>0, h>0,
            (row[kCGWindowLayer as String] as? Int ?? 0) == 0 else { return nil }
        return WindowCandidate(id:id,pid:owner,title:row[kCGWindowName as String] as? String ?? "",bounds:WindowBounds(x:x,y:y,width:w,height:h))
    }
}
func axBounds(_ element: AXUIElement) -> WindowBounds? {
    guard let p=attribute(element,"AXPosition"), let z=attribute(element,"AXSize") else { return nil }
    guard CFGetTypeID(p)==AXValueGetTypeID(), CFGetTypeID(z)==AXValueGetTypeID() else { return nil }
    var point=CGPoint.zero, size=CGSize.zero
    guard AXValueGetValue(p as! AXValue,.cgPoint,&point), AXValueGetValue(z as! AXValue,.cgSize,&size) else { return nil }
    return WindowBounds(x:point.x,y:point.y,width:size.width,height:size.height)
}
func windowForAX(_ root: AXUIElement, pid: Int32) throws -> WindowCandidate {
    guard let bounds=axBounds(root), let window=matchingWindow(pid:pid,title:string(root,"AXTitle") ?? "",bounds:bounds,candidates:visibleWindows(pid:pid)) else {
        throw Failure("Pencere kimliği kesin eşleşmiyor. desktop_windows ile pencereyi seçip yeniden gözlemle; başka pencereye geçilmedi.")
    }
    return window
}
func selectedAXWindow(pid: Int32, windowId: UInt32?, allowActivation: Bool = true) throws -> AXUIElement {
    let appElement=AXUIElementCreateApplication(pid)
    if let windowId {
        let windows=attribute(appElement,"AXWindows") as? [AXUIElement] ?? []
        let matches=windows.filter { (try? windowForAX($0,pid:pid).id)==windowId }
        guard matches.count==1 else { throw Failure("Seçilen pencere kapandı veya kesin eşleşmiyor. Yeniden gözlemle.") }
        return matches[0]
    }
    var found=windowElement(of:appElement)
    if found==nil, allowActivation, let app=NSRunningApplication(processIdentifier:pid), focusedApplicationPID() != pid { app.activate(options:[]); usleep(500_000); found=windowElement(of:appElement) }
    guard let root=found else { throw Failure("Uygulama pencere yayınlamıyor; desktop_describe part=menu kullanılabilir.") }
    return root
}
func validateObservation(_ args: JSON, app: NSRunningApplication, activate: Bool=false) throws -> Observation {
    guard accessibilityTrusted(prompt:false) else { throw Failure("Erişilebilirlik izni yok.") }
    guard let id=args["snapshotId"] as? String, let observed=observations[id],
        ((args["windowId"] as? NSNumber)?.uint32Value == nil || (args["windowId"] as? NSNumber)?.uint32Value == observed.window.id),
        observed.pid==app.processIdentifier, observed.bundleId==(app.bundleIdentifier ?? ""), observed.launch==app.launchDate,
        latestObservation[observationKey(observed.pid,observed.part,observed.window.id)]==id,
        Date().timeIntervalSince(observed.at)<120 else { throw Failure("Snapshot eski veya bu uygulamaya ait değil. Yeniden gözlemle; input gönderilmedi.") }
    let root:AXUIElement, window:AXUIElement?
    if observed.part=="menu" {
        guard let bar=attribute(AXUIElementCreateApplication(observed.pid),"AXMenuBar") else { throw Failure("Menü kapandı.") }
        root=bar as! AXUIElement; window=nil
    } else {
        guard let current=visibleWindows(pid:observed.pid).first(where:{$0.id==observed.window.id}), current.bounds.matches(observed.window.bounds),
            (current.title.isEmpty || observed.window.title.isEmpty || current.title==observed.window.title),
            let selected=try? selectedAXWindow(pid:observed.pid,windowId:observed.window.id) else { throw Failure("Pencere taşındı, kapandı veya değişti. Yeniden gözlemle; input gönderilmedi.") }
        root=selected;window=selected
    }
    let currentTree=Tree();currentTree.build(from:root)
    guard currentTree.lines==observed.tree.lines, treeLayout(currentTree)==observed.layout else { throw Failure("Pencere içeriği değişti; eski ref kullanılamaz. Yeniden gözlemle.") }
    if activate {
        guard !observed.background else { throw Failure("A background snapshot cannot authorise foreground input. No input sent.") }
        requestTargetFocus(app,window:window)
        guard waitForFocus(pid:observed.pid,window:window) else { throw Failure("Seçilen pencere odaklanmadı; input gönderilmedi.") }
        // Activation is not authority to deliver to a changed target.
        return try validateObservation(args,app:app)
    }
    return observed
}

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

func describe(pid: Int32, part: String, windowId: UInt32? = nil, background: Bool = false, taskPermissionIdentity: JSON? = nil) throws -> JSON {
    guard accessibilityTrusted(prompt: false) else {
        throw Failure("Erişilebilirlik izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik.")
    }
    let root:AXUIElement, window:WindowCandidate
    if part=="menu" {
        guard let bar=attribute(AXUIElementCreateApplication(pid),"AXMenuBar") else { throw Failure("Menü okunamıyor.") }
        root=bar as! AXUIElement
        window=WindowCandidate(id:0,pid:pid,title:"menu",bounds:axBounds(root) ?? WindowBounds(x:0,y:0,width:0,height:0))
    } else {
        root=try selectedAXWindow(pid:pid,windowId:windowId,allowActivation: !background)
        window=try windowForAX(root,pid:pid)
    }
    if let expected=taskPermissionIdentity {
        guard background,part=="window" else{throw Failure("Task permission is for one background window only.")}
        try requireBackgroundTaskPermissionIdentity(expected,pid:pid,windowId:windowId)
    }
    let tree = Tree()
    tree.build(from: root)
    if let expected=taskPermissionIdentity {try requireBackgroundTaskPermissionIdentity(expected,pid:pid,windowId:windowId)}
    guard let app=NSRunningApplication(processIdentifier:pid) else { throw Failure("Uygulama kapandı.") }
    let key=observationKey(pid,part,window.id)
    let previous=latestObservation[key].flatMap { observations[$0]?.tree.lines }
    let observation=Observation(id:UUID().uuidString,pid:pid,bundleId:app.bundleIdentifier ?? "",launch:app.launchDate,part:part,window:window,root:root,tree:tree,at:Date(),layout:treeLayout(tree),focused:focusedElement(pid),background:background,sliders:background ? observeSliderStates(pid:pid,bundle:app.bundleIdentifier ?? "",tree:tree,window:window.bounds):[:])
    if let old=latestObservation[key] { observations.removeValue(forKey:old) }
    observations[observation.id]=observation;latestObservation[key]=observation.id
    var result=observation.json
    result["controlMode"] = background ? "backgroundStrict" : "foreground"
    if background {
        result["extendedTargets"] = extendedBackgroundTargets(observation)
        result["documentPath"] = documentPath(root)
        result["targets"] = tree.elements.keys.sorted().compactMap { ref -> JSON? in
            guard let element=tree.elements[ref], let label=tree.labels[ref] else { return nil }
            let role=string(element,"AXRole") ?? ""
            let subrole=string(element,"AXSubrole") ?? ""
            let actions=["press","set-value"].filter { action in
                guard backgroundCapability(bundle:observation.bundleId,role:role,action:action,subrole:subrole), attribute(element,"AXEnabled") as? Bool != false else { return false }
                if action == "press" {
                    var names:CFArray?
                    return AXUIElementCopyActionNames(element,&names) == .success && (names as? [String] ?? []).contains("AXPress")
                }
                var settable:DarwinBoolean=false
                return AXUIElementIsAttributeSettable(element,"AXValue" as CFString,&settable) == .success && settable.boolValue
            }
            guard !actions.isEmpty else { return nil }
            var target:JSON=["ref":ref,"role":role,"label":label,"backgroundActions":actions]
            if let value=string(element,"AXValue") { target["value"]=value }
            return target
        }
    }
    result["text"]=tree.lines.joined(separator:"\n"); result["count"]=tree.lines.count;result["inputValues"]=tree.inputValues
    result["changed"]=previous.map { diff(from:$0,to:tree.lines) } ?? NSNull()
    return result
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
func capture(pid: Int32, windowId: UInt32, bounds: WindowBounds, to path: String) throws -> JSON {
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
                .first(where: { $0.owningApplication?.processID == pid && $0.windowID == windowId && bounds.matches(WindowBounds(x:$0.frame.minX,y:$0.frame.minY,width:$0.frame.width,height:$0.frame.height)) })
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

func typeText(_ text: String, validate:() throws -> Void) throws {
    let source = CGEventSource(stateID: .combinedSessionState)
    // One grapheme per key event: key handlers may ignore later Unicode units.
    try deliverUnicodeInput(text, validate:validate) { units in
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
    var args = request["args"] as? JSON ?? [:]

    do {
        switch op {
        case "ping":
            respond(id: id, result: ["version": 1])

        case "scheduled_recipe_targets":
            respond(id:id,result:try scheduledRecipeTargets())
        case "scheduled_recipe_environment":
            respond(id:id,result:try scheduledEnvironment(false))
        case "scheduled_recipe_prepare", "scheduled_recipe_revalidate":
            respond(id:id,result:try scheduledRecipePrepare(args))
        case "scheduled_recipe_backup":
            do{respond(id:id,result:try scheduledRecipeBackup(args))}catch{respond(id:id,result:["status":"no-input","noInputSent":true,"reasonCode":"backup-unavailable"])}
        case "scheduled_document_append":
            do{respond(id:id,result:try scheduledDocumentAppend(args))}catch{respond(id:id,result:["status":"rejected","noInputSent":true,"reasonCode":"native-precondition"])}
        case "scheduled_document_save":
            do{respond(id:id,result:try scheduledDocumentSave(args))}catch{respond(id:id,result:["status":"rejected","noInputSent":true,"reasonCode":"native-precondition"])}

        case "background_target_identity":
            respond(id:id,result:try backgroundTargetIdentity(args))

        case "background_environment":
            respond(id:id,result:readBackgroundEnvironment())

        case "input_idle":
            // Hardware input only: what the helper posts itself must not look like the user.
            respond(id:id,result:["seconds":CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:CGEventType(rawValue:UInt32.max)!)])

        case "permissions":
            respond(id: id, result: permissions(prompt: args["prompt"] as? Bool ?? false))

        case "apps":
            respond(id: id, result: ["apps": runningApps()])

        case "focus":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("\"\(args["app"] as? String ?? "")\" diye açık bir uygulama yok.")
            }
            requestTargetFocus(found)
            guard waitForFocus(pid:found.processIdentifier) else { throw Failure("Seçilen pencere odaklanmadı; input gönderilmedi.") }
            respond(id: id, result: ["name": found.localizedName ?? "", "pid": Int(found.processIdentifier)])

        case "windows":
            guard let target=args["app"] as? String, let found=app(matching:target) else { throw Failure("Uygulama bulunamadı.") }
            guard accessibilityTrusted(prompt:false) else { throw Failure("Erişilebilirlik izni yok.") }
            let pid=found.processIdentifier
            var windows=attribute(AXUIElementCreateApplication(pid),"AXWindows") as? [AXUIElement] ?? []
            if windows.isEmpty && args["background"] as? Bool != true { _ = try? selectedAXWindow(pid:pid,windowId:nil); windows=attribute(AXUIElementCreateApplication(pid),"AXWindows") as? [AXUIElement] ?? [] }
            let ax=windows.compactMap { element -> AXWindowCandidate? in guard let bounds=axBounds(element) else { return nil }; return AXWindowCandidate(title:string(element,"AXTitle") ?? "",bounds:bounds) }
            respond(id:id,result:["windows":labelledWindows(pid:pid,ax:ax,candidates:visibleWindows(pid:pid)).map { ["windowId":Int($0.id),"title":$0.title,"bounds":$0.bounds.json] as JSON }])

        case "describe":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("\"\(args["app"] as? String ?? "")\" diye açık bir uygulama yok.")
            }
            var result = try describe(pid: found.processIdentifier, part: args["part"] as? String ?? "window", windowId:(args["windowId"] as? NSNumber)?.uint32Value, background:args["background"] as? Bool == true, taskPermissionIdentity:args["taskPermissionIdentity"] as? JSON)
            result["app"] = found.localizedName ?? ""
            result["pid"] = Int(found.processIdentifier)
            respond(id: id, result: result)

        case "validate_snapshot":
            guard let target=args["app"] as? String, let found=app(matching:target) else { throw Failure("Uygulama kapandı.") }
            let observed=try validateObservation(args,app:found)
            if let ref=args["ref"] as? Int { _ = try requireTargetLabel(args["label"] as? String,actual:observed.tree.labels[ref]) }
            respond(id:id, result:observed.json)

        case "filesystem_move_noreplace":
            respond(id:id,result:safeFileMove(args))
        case "document_move_observe":
            respond(id:id,result:try observeDocumentMove(args))
        case "validate_document_move":
            respond(id:id,result:try validateDocumentMove(args))
        case "background_document_move":
            respond(id:id,result:try backgroundDocumentMove(args))
        case "background_open_document":
            guard let path=args["path"] as? String else {throw Failure("Document path required.")}
            respond(id:id,result:try backgroundOpenDocument(path:path))
        case "background_save_document":
            respond(id:id,result:try backgroundSaveDocument(args))
        case "validate_background_action", "background_scroll_position", "background_menu_open", "background_menu_select", "background_drag":
            if op != "validate_background_action" {args["action"] = op == "background_scroll_position" ? "scroll-position" : op == "background_menu_open" ? "menu-open" : op == "background_drag" ? "drag":"menu-select"}
            respond(id:id,result:try performExtendedBackground(args,validateOnly:op == "validate_background_action"))
        case "validate_background", "background_press", "background_set_value":
            try checkBackgroundSession()
            guard let target=args["app"] as? String, let found=app(matching:target) else { throw Failure("Target app closed; no input sent.") }
            let observed=try validateObservation(args,app:found)
            guard observed.background, observed.part == "window" else { throw Failure("A background window snapshot is required; no foreground fallback.") }
            try requireBackgroundTarget(target:observed.pid,foreground:focusedApplicationPID())
            guard let ref=args["ref"] as? Int, let element=observed.tree.elements[ref] else { throw Failure("The target ref is unavailable; no input sent.") }
            _ = try requireTargetLabel(args["label"] as? String,actual:observed.tree.labels[ref])
            let action = op == "background_set_value" || args["action"] as? String == "set-value" ? "set-value" : "press"
            guard backgroundCapability(bundle:observed.bundleId,role:string(element,"AXRole") ?? "",action:action,subrole:string(element,"AXSubrole") ?? ""),
                  attribute(element,"AXEnabled") as? Bool != false else { throw Failure("Unsupported background capability. No activation, key or pointer fallback; wait for the user.") }
            AXUIElementSetMessagingTimeout(element,0.5)
            if action == "press" {
                var names:CFArray?
                guard AXUIElementCopyActionNames(element,&names) == .success, (names as? [String] ?? []).contains("AXPress") else { throw Failure("Background AXPress is unavailable; no input sent.") }
            } else {
                var settable:DarwinBoolean = false
                guard AXUIElementIsAttributeSettable(element,"AXValue" as CFString,&settable) == .success, settable.boolValue else { throw Failure("Background AXValue is not writable; no input sent.") }
                guard let text=args["text"] as? String else { throw Failure("Replacement text is required.") }
                try requireBackgroundReplacement(expected:args["expectedValue"] as? String,current:string(element,"AXValue"),replacement:text)
            }
            if op == "validate_background" {
                var result=observed.json; result["controlMode"]="backgroundStrict"
                respond(id:id,result:result); break
            }
            // The blocking helper loop is a single writer. Revalidate immediately
            // before the one semantic operation; never post a global event.
            _ = try validateObservation(args,app:found)
            let foreground=focusedApplicationPID()
            try checkBackgroundSession()
            try requireBackgroundTarget(target:observed.pid,foreground:foreground)
            guard let cursor=CGEvent(source:nil)?.location else { throw Failure("Cursor state unavailable; no input sent.") }
            let operationId=UUID().uuidString,started=Date()
            let delivery:AXError
            if action == "press" { delivery=AXUIElementPerformAction(element,"AXPress" as CFString) }
            else {
                let text=args["text"] as! String
                try requireBackgroundReplacement(expected:args["expectedValue"] as? String,current:string(element,"AXValue"),replacement:text)
                delivery=AXUIElementSetAttributeValue(element,"AXValue" as CFString,text as CFString)
            }
            usleep(50_000)
            var result:JSON
            do { result=try describe(pid:observed.pid,part:"window",windowId:observed.window.id,background:true) }
            catch { result=["status":"unknown","reasonCode":"post-observation-unavailable","detail":String(describing:error)] }
            let afterForeground=focusedApplicationPID()
            let foregroundChanged=backgroundForegroundDisturbed(before:foreground,after:afterForeground,target:observed.pid,userActed:userActed(since:started))
            let cursorChanged=backgroundCursorDisturbed(before:cursor,after:CGEvent(source:nil)?.location,userMoved:userMovedPointer(since:started))
            result["operationId"]=operationId; result["backend"]="ax";result["controlMode"]="backgroundStrict"
            result["foregroundBefore"]=foreground.map { Int($0) as Any } ?? NSNull(); result["foregroundAfter"]=afterForeground.map { Int($0) as Any } ?? NSNull()
            result["foregroundChanged"]=foregroundChanged;result["cursorChanged"]=cursorChanged;result["cleanup"]="complete"
            if backgroundDeliveryUncertain(deliverySucceeded:delivery == .success,foregroundChanged:foregroundChanged,cursorChanged:cursorChanged,sessionVerified:(try? checkBackgroundSession()) != nil) {
                result["status"]="unknown";result["reasonCode"]=foregroundChanged ? "foreground-changed" : cursorChanged ? "cursor-changed" : "ax-delivery-uncertain"
            } else if result["status"] == nil {
                if action == "set-value" {
                    // Read the exact target, not a matching caption elsewhere.
                    result["status"] = string(element,"AXValue") == (args["text"] as? String) ? "verified" : "unknown"
                } else { result["status"] = result["changed"] as? String == "(değişiklik yok)" ? "ineffective" : "delivered" }
            }
            respond(id:id,result:result)

        case "click", "doubleclick":
            guard accessibilityTrusted(prompt: false) else {
                throw Failure("Erişilebilirlik izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik.")
            }
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("Uygulama bulunamadı.")
            }
            let observed=try validateObservation(args,app:found,activate:true)
            guard let ref=args["ref"] as? Int, let element=observed.tree.elements[ref] else { throw Failure("Ref bu snapshot'ta yok. Yeniden gözlemle.") }
            let targetLabel=try requireTargetLabel(args["label"] as? String,actual:observed.tree.labels[ref])
            guard let spot=centre(element) else { throw Failure("Bu öğenin ekranda bir yeri yok.") }
            if observed.part != "menu" && !CGRect(x:observed.window.bounds.x,y:observed.window.bounds.y,width:observed.window.bounds.width,height:observed.window.bounds.height).contains(spot) { throw Failure("Öğe seçilen pencerenin dışında; input gönderilmedi.") }
            var actionNames:CFArray?
            let canPress=op=="click" && AXUIElementCopyActionNames(element,&actionNames) == .success && (actionNames as? [String] ?? []).contains("AXPress")
            if canPress {
                guard AXUIElementPerformAction(element,"AXPress" as CFString) == .success else { throw Failure("The target refused AXPress; observe the actual result before retrying.") }
            } else { clickPoint(spot,double:op=="doubleclick") }
            usleep(250_000)
            var result=observed.json;result["x"]=spot.x;result["y"]=spot.y;result["targetLabel"]=targetLabel;result["inputMethod"]=canPress ? "accessibility-press" : "pointer"
            respond(id:id,result:result)

        case "type":
            guard accessibilityTrusted(prompt: false) else {
                throw Failure("Erişilebilirlik izni yok.")
            }
            guard let text = args["text"] as? String, !text.isEmpty else { throw Failure("Yazılacak bir metin gerekiyor.") }
            guard let target=args["app"] as? String, let found=app(matching:target) else { throw Failure("Uygulama bulunamadı.") }
            let observed=try validateObservation(args,app:found,activate:true)
            guard let expected=observed.focused, let current=focusedElement(observed.pid), CFEqual(expected,current) else { throw Failure("Metin odağı değişti; yeniden gözlemle. Input gönderilmedi.") }
            guard text.count<=2000 else { throw Failure("Text input is limited to 2000 characters per action; nothing was typed.") }
            try typeText(text) {
                guard AXIsProcessTrusted(), focusedApplicationPID()==observed.pid,
                      let focus=focusedElement(observed.pid), CFEqual(expected,focus),
                      let window=visibleWindows(pid:observed.pid).first(where:{$0.id==observed.window.id}), window.bounds.matches(observed.window.bounds) else {
                    throw Failure("Typing stopped because permission, focus or window changed. Text may be partial; observe before retrying.")
                }
            }
            var result=observed.json;result["typed"]=text.count
            respond(id:id,result:result)

        case "screenshot":
            guard let target = args["app"] as? String, let found = app(matching: target) else {
                throw Failure("Uygulama bulunamadı.")
            }
            guard let path = args["path"] as? String, !path.isEmpty else {
                throw Failure("Görüntünün yazılacağı bir yol gerekiyor.")
            }
            if args["snapshotId"] == nil {
                let look=try describe(pid:found.processIdentifier,part:"window",windowId:(args["windowId"] as? NSNumber)?.uint32Value)
                args["snapshotId"]=look["snapshotId"]
            }
            let observed=try validateObservation(args,app:found)
            guard observed.part=="window" else { throw Failure("Screenshot requires a window snapshot. Describe part=window first.") }
            var shot = try capture(pid: found.processIdentifier, windowId:observed.window.id,bounds:observed.window.bounds,to:path)
            _ = try validateObservation(args,app:found)
            shot.merge(observed.json) { _,new in new }
            shot["imageCoordinateFrame"]="window-pixels"
            shot["app"] = found.localizedName ?? ""
            respond(id: id, result: shot)

        case "request_screen_recording":
            // Shows the system dialog once; after that the user has to do it
            // in System Settings, and the app has to be restarted.
            respond(id: id, result: ["asked": CGRequestScreenCaptureAccess()])

        case "key":
            guard accessibilityTrusted(prompt: false) else { throw Failure("Erişilebilirlik izni yok.") }
            guard let target=args["app"] as? String, let found=app(matching:target) else { throw Failure("Uygulama bulunamadı.") }
            let observed=try validateObservation(args,app:found,activate:true)
            let current=focusedElement(observed.pid)
            guard (observed.focused==nil && current==nil) || (observed.focused != nil && current != nil && CFEqual(observed.focused!,current!)) else { throw Failure("Tuş odağı değişti; yeniden gözlemle. Input gönderilmedi.") }
            try pressKey(args["combo"] as? String ?? "")
            var result=observed.json;result["pressed"]=args["combo"] as? String ?? ""
            respond(id:id,result:result)

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
