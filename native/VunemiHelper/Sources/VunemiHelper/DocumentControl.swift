import AppKit
import Carbon
import ApplicationServices
import CryptoKit

func requireDocumentSave(expectedField:String,currentField:String?,expectedDiskHash:String,currentDiskHash:String) throws {
    guard currentField == expectedField, (expectedDiskHash == currentDiskHash || currentDiskHash == SHA256.hash(data:Data(expectedField.utf8)).map { String(format:"%02x",$0) }.joined()) else {
        throw Failure("Document field or disk changed; no save sent. Observe again without overwriting the user's work.")
    }
}
struct DocumentScriptRequest { let source:String; let arguments:[String] }
func documentSaveScriptRequest(path:String,expected:String) -> DocumentScriptRequest {
    // Arguments are Apple-event data, never interpolated into executable source.
    DocumentScriptRequest(source:"""
    on run argv
      set wantedPath to item 1 of argv
      set wantedText to item 2 of argv
      set wantedFile to POSIX file wantedPath as alias
      tell application id "com.apple.TextEdit"
        set matches to {}
        repeat with candidate in documents
          try
            set candidateFile to POSIX file (path of candidate) as alias
            if candidateFile is wantedFile then set end of matches to contents of candidate
          end try
        end repeat
        if (count of matches) is not 1 then error "Document is missing or ambiguous"
        set targetDocument to item 1 of matches
        if (text of targetDocument as text) is not wantedText then error "Document text changed before save"
        save targetDocument
        if modified of targetDocument then error "Document remains modified"
        return wantedPath
      end tell
    end run
    """,arguments:[path,expected])
}
func documentURL(_ path:String) throws -> URL {
    let url=URL(fileURLWithPath:path).standardizedFileURL.resolvingSymlinksInPath()
    let values=try url.resourceValues(forKeys:[.isRegularFileKey,.fileSizeKey])
    guard path.hasPrefix("/"),url.pathExtension == "txt",values.isRegularFile == true,(values.fileSize ?? 100_000)<=64_000 else { throw Failure("An existing bounded .txt document is required.") }
    return url
}
func diskHash(_ url:URL) throws -> String {
    SHA256.hash(data:try Data(contentsOf:url)).map { String(format:"%02x",$0) }.joined()
}
func documentPath(_ window:AXUIElement) -> String? {
    guard let raw=string(window,"AXDocument"),let url=URL(string:raw),url.isFileURL else {return nil}
    return url.standardizedFileURL.resolvingSymlinksInPath().path
}
func documentWindow(pid:Int32,url:URL) throws -> AXUIElement {
    let windows=attribute(AXUIElementCreateApplication(pid),"AXWindows") as? [AXUIElement] ?? []
    let matches=windows.filter { documentPath($0) == url.path }
    guard matches.count == 1 else {throw Failure("A unique window with the exact document URL is required; no focus fallback.")}
    return matches[0]
}
private final class DocumentOpenReply: @unchecked Sendable {
    private let lock=NSLock()
    private var state:(Bool,NSRunningApplication?,Error?)=(false,nil,nil)
    func finish(_ app:NSRunningApplication?,_ error:Error?){lock.lock();defer{lock.unlock()};state=(true,app,error)}
    func read()->(Bool,NSRunningApplication?,Error?){lock.lock();defer{lock.unlock()};return state}
}
func waitForDocumentObservation(timeout:TimeInterval,read:()->JSON?) throws -> JSON {
    let deadline=Date(timeIntervalSinceNow:timeout)
    while Date()<deadline {
        if let observation=read(){return observation}
        RunLoop.main.run(until:Date(timeIntervalSinceNow:0.025))
    }
    throw Failure("Opened document identity did not settle; no input sent.")
}
func backgroundOpenDocument(path:String) throws -> JSON {
    try checkBackgroundSession()
    guard accessibilityTrusted(prompt:false),let foreground=focusedApplicationPID() else {throw Failure("Accessibility or foreground state unavailable; no document opened.")}
    if let target=app(matching:"com.apple.TextEdit") {try requireBackgroundTarget(target:target.processIdentifier,foreground:foreground)}
    let url=try documentURL(path)
    guard let appURL=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.apple.TextEdit") else {throw Failure("TextEdit is unavailable.")}
    let configuration=NSWorkspace.OpenConfiguration();configuration.activates=false;configuration.addsToRecentItems=false;configuration.hides=false
    // Do not activate even when launching. Pump the run loop for completion;
    // no semaphore on main, no global keyboard/pointer/clipboard fallback.
    let reply=DocumentOpenReply()
    NSWorkspace.shared.open([url],withApplicationAt:appURL,configuration:configuration) { running,error in
        reply.finish(running,error)
    }
    let deadline=Date(timeIntervalSinceNow:5)
    while !reply.read().0 && Date()<deadline {RunLoop.main.run(until:Date(timeIntervalSinceNow:0.02))}
    let (answered,launched,openError)=reply.read()
    guard answered,openError == nil,let target=launched ?? app(matching:"com.apple.TextEdit") else {throw Failure("Background document open did not complete: \(String(describing:openError)).")}
    var result=try waitForDocumentObservation(timeout:max(0,deadline.timeIntervalSinceNow)) {
        guard let window=try? documentWindow(pid:target.processIdentifier,url:url),
              let candidate=try? windowForAX(window,pid:target.processIdentifier),
              let observation=try? describe(pid:target.processIdentifier,part:"window",windowId:candidate.id,background:true) else {return nil}
        return observation
    }
    let after=focusedApplicationPID();try checkBackgroundSession()
    guard after == foreground else {throw Failure("Foreground changed while opening; no edit sent.")}
    result["documentPath"]=url.path;result["foregroundBefore"]=Int(foreground);result["foregroundAfter"]=after.map{Int($0)};result["foregroundChanged"]=false
    return result
}
func requireDocumentIdentity(expectedPID:Int32,currentPID:Int32,expectedWindow:UInt32,currentWindow:UInt32,expectedPath:String,currentPath:String?) throws {
    guard expectedPID == currentPID,expectedWindow == currentWindow,expectedPath == currentPath else {throw Failure("Document identity changed; no save sent.")}
}
func documentAlreadySaved(expected:String,field:String?,disk:String?) -> Bool {
    guard let field,let disk else {return false}
    return Data(expected.utf8) == Data(field.utf8) && Data(expected.utf8) == Data(disk.utf8)
}
/// Saving is a semantic document action, not a click at an old UI ref. Keep
/// the native process/window/file identity while rereading the unique field;
/// scrollbars, sharing badges and document-action chrome are not its authority.
func documentSaveField(_ args:JSON,app:NSRunningApplication,url:URL) throws -> (Observation,AXUIElement) {
    guard let snapshot=args["snapshotId"] as? String,let observed=observations[snapshot],observed.background,
          observed.pid == app.processIdentifier,observed.launch == app.launchDate,observed.bundleId == "com.apple.TextEdit",
          Date().timeIntervalSince(observed.at)<120 else {throw Failure("Document snapshot identity expired; no save sent.")}
    let root=try documentWindow(pid:app.processIdentifier,url:url),window=try windowForAX(root,pid:app.processIdentifier)
    try requireDocumentIdentity(expectedPID:observed.pid,currentPID:app.processIdentifier,expectedWindow:observed.window.id,currentWindow:window.id,expectedPath:url.path,currentPath:documentPath(root))
    let tree=Tree();tree.build(from:root)
    let fields=tree.elements.values.filter {string($0,"AXRole") == "AXTextArea" && (string($0,"AXSubrole") ?? "").isEmpty}
    guard fields.count == 1 else {throw Failure("A unique readable document field is required; no save sent.")}
    return (observed,fields[0])
}
func backgroundSaveDocument(_ args:JSON) throws -> JSON {
    try checkBackgroundSession()
    guard let target=args["app"] as? String,let found=app(matching:target),found.bundleIdentifier == "com.apple.TextEdit",
          let path=args["path"] as? String,let expected=args["expectedValue"] as? String,let expectedDisk=args["expectedDiskHash"] as? String else {throw Failure("Exact TextEdit save identity is required.")}
    let foreground=focusedApplicationPID();try requireBackgroundTarget(target:found.processIdentifier,foreground:foreground)
    let url=try documentURL(path)
    let (observed,initialField)=try documentSaveField(args,app:found,url:url)
    try requireDocumentSave(expectedField:expected,currentField:string(initialField,"AXValue"),expectedDiskHash:expectedDisk,currentDiskHash:diskHash(url))
    // TextEdit autosaves in place. Prefer independently verified persistence
    // to asking for another system privilege when the app has already saved.
    let autosaveDeadline=Date(timeIntervalSinceNow:2)
    repeat {
        let (_,current)=try documentSaveField(args,app:found,url:url)
        if documentAlreadySaved(expected:expected,field:string(current,"AXValue"),disk:try? String(contentsOf:url,encoding:.utf8)) {
            let after=focusedApplicationPID()
            guard after == foreground else {throw Failure("Foreground changed during save verification; no input sent.")}
            var result=try describe(pid:found.processIdentifier,part:"window",windowId:observed.window.id,background:true)
            result["documentPath"]=url.path;result["status"]="saved";result["operationId"]=UUID().uuidString;result["saveBackend"]="autosave-verified";result["foregroundChanged"]=false
            result["foregroundBefore"]=foreground.map{Int($0)};result["foregroundAfter"]=after.map{Int($0)}
            return result
        }
        RunLoop.main.run(until:Date(timeIntervalSinceNow:0.05))
    } while Date()<autosaveDeadline
    // Ask TCC only inside the already approved tool, before saving. Never
    // activate TextEdit to obtain this privilege or dismiss a system refusal.
    var address=AEAddressDesc()
    let bundle="com.apple.TextEdit"
    let create=bundle.withCString { AECreateDesc(DescType(typeApplicationBundleID),$0,bundle.utf8.count,&address) }
    guard create == noErr else {throw Failure("Automation target unavailable; no save sent.")}
    defer {AEDisposeDesc(&address)}
    let permission=AEDeterminePermissionToAutomateTarget(&address,AEEventClass(kAECoreSuite),AEEventID(kAESave),true)
    guard permission == noErr else {throw Failure("TextEdit Automation permission is required (\(permission)); macOS permission was requested. No save sent.")}
    // A permission dialog is a wait: repeat every guard immediately afterwards.
    try checkBackgroundSession()
    _ = try waitForDocumentObservation(timeout:0.75) {
        guard let current=focusedApplicationPID(),current == foreground,current != found.processIdentifier else {return nil}
        return ["pid":Int(current)]
    }
    let (_,element)=try documentSaveField(args,app:found,url:url)
    try requireDocumentSave(expectedField:expected,currentField:string(element,"AXValue"),expectedDiskHash:expectedDisk,currentDiskHash:diskHash(url))
    let request=documentSaveScriptRequest(path:url.path,expected:expected)
    let operationId=UUID().uuidString
    let savedPath:String
    do {savedPath=try executeDocumentScriptRequest(request)}
    catch {return ["status":"unknown","operationId":operationId,"detail":String(describing:error),"foregroundChanged":foreground != focusedApplicationPID()]}
    guard savedPath == url.path else {return ["status":"unknown","operationId":operationId,"detail":"Saved path could not be verified.","foregroundChanged":foreground != focusedApplicationPID()]}
    var result:JSON
    do {result=try describe(pid:found.processIdentifier,part:"window",windowId:observed.window.id,background:true)}
    catch {return ["status":"unknown","operationId":operationId,"detail":String(describing:error)]}
    let after=focusedApplicationPID()
    result["saveBackend"]="apple-events";result["documentPath"]=url.path;result["operationId"]=operationId;result["foregroundBefore"]=foreground.map{Int($0)};result["foregroundAfter"]=after.map{Int($0)};result["foregroundChanged"]=foreground != after
    let disk=try? String(contentsOf:url,encoding:.utf8)
    result["status"] = disk == expected && string(element,"AXValue") == expected && foreground == after ? "saved" : "unknown"
    return result
}

func executeDocumentScriptRequest(_ request:DocumentScriptRequest) throws -> String {
    guard let script=NSAppleScript(source:request.source) else {throw Failure("Save script unavailable.")}
    let argv=NSAppleEventDescriptor.list()
    for (index,value) in request.arguments.enumerated() {argv.insert(NSAppleEventDescriptor(string:value),at:index+1)}
    // An implicit `on run argv` handler receives an open-application event,
    // not a named subroutine event (which returns -1708).
    let event=NSAppleEventDescriptor(eventClass:AEEventClass(kCoreEventClass),eventID:AEEventID(kAEOpenApplication),targetDescriptor:nil,returnID:AEReturnID(kAutoGenerateReturnID),transactionID:AETransactionID(kAnyTransactionID))
    event.setParam(argv,forKeyword:AEKeyword(keyDirectObject))
    var error:NSDictionary?
    let response=script.executeAppleEvent(event,error:&error)
    guard error == nil,let value=response.stringValue else {throw Failure("TextEdit save script refused: \(String(describing:error)).")}
    return value
}
