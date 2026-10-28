import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Darwin

func movedDocumentText(_ text:String,source:NSRange,destination:Int)throws->String{
    let count=(text as NSString).length
    let units=Array(text.utf16)
    func boundary(_ index:Int)->Bool{index==0 || index==count || (index>0 && index<count && !(units[index-1]>=0xd800 && units[index-1]<=0xdbff && units[index]>=0xdc00 && units[index]<=0xdfff))}
    guard source.location>=0,source.length>0,source.location<=count,source.length<=count-source.location,destination>=0,destination<=count,
          !(destination>=source.location && destination<=source.location+source.length),Range(source,in:text) != nil,
          Range(NSRange(location:destination,length:0),in:text) != nil,boundary(source.location),boundary(source.location+source.length),boundary(destination) else{throw Failure("Move range or destination is invalid; no edit sent.")}
    let original=text as NSString,selected=original.substring(with:source),remaining=original.replacingCharacters(in:source,with:"") as NSString
    let offset=destination>source.location ? destination-source.length:destination
    let next=remaining.replacingCharacters(in:NSRange(location:offset,length:0),with:selected)
    guard next != text else{throw Failure("Move has no observable content change; no edit sent.")};return next
}
func requireDocumentMoveVersion(before:String,current:String?,source:NSRange,currentSelection:NSRange?,diskHash:String,currentDiskHash:String)throws{
    guard current==before,currentSelection==source,diskHash==currentDiskHash else{throw Failure("Document text, selection or disk changed; no edit sent.")}
}
func moveHash(_ text:String)->String{SHA256.hash(data:Data(text.utf8)).map{String(format:"%02x",$0)}.joined()}
private func moveObject(_ wanted:OSType,_ form:OSType,_ data:NSAppleEventDescriptor,_ container:NSAppleEventDescriptor)throws->NSAppleEventDescriptor{
    let record=NSAppleEventDescriptor.record()
    record.setDescriptor(NSAppleEventDescriptor(typeCode:wanted),forKeyword:AEKeyword(keyAEDesiredClass))
    record.setDescriptor(NSAppleEventDescriptor(enumCode:form),forKeyword:AEKeyword(keyAEKeyForm))
    record.setDescriptor(data,forKeyword:AEKeyword(keyAEKeyData));record.setDescriptor(container,forKeyword:AEKeyword(keyAEContainer))
    guard let spec=record.coerce(toDescriptorType:DescType(typeObjectSpecifier)) else{throw Failure("Document object specifier unavailable.")};return spec
}
func moveProperty(_ code:OSType,_ container:NSAppleEventDescriptor)throws->NSAppleEventDescriptor{try moveObject(0x70726f70,OSType(formPropertyID),NSAppleEventDescriptor(typeCode:code),container)}
/// Stable URL predicate, never a document index/name or executable AppleScript interpolation.
func documentMoveSpecifier(path:String)throws->NSAppleEventDescriptor{
    guard let examined=NSAppleEventDescriptor(descriptorType:DescType(typeObjectBeingExamined),data:Data()) else{throw Failure("Document predicate unavailable.")}
    let comparison=NSAppleEventDescriptor.record()
    comparison.setDescriptor(NSAppleEventDescriptor(enumCode:OSType(kAEEquals)),forKeyword:AEKeyword(keyAECompOperator))
    comparison.setDescriptor(try moveProperty(0x70707468,examined),forKeyword:AEKeyword(keyAEObject1))
    comparison.setDescriptor(NSAppleEventDescriptor(string:path),forKeyword:AEKeyword(keyAEObject2))
    guard let test=comparison.coerce(toDescriptorType:DescType(typeCompDescriptor)) else{throw Failure("Document predicate unavailable.")}
    return try moveObject(0x646f6375,OSType(formTest),test,NSAppleEventDescriptor.null())
}
func documentMoveEvent(pid:Int32,eventID:OSType,direct:NSAppleEventDescriptor)->NSAppleEventDescriptor{
    let event=NSAppleEventDescriptor(eventClass:AEEventClass(kAECoreSuite),eventID:AEEventID(eventID),targetDescriptor:NSAppleEventDescriptor(processIdentifier:pid),returnID:AEReturnID(kAutoGenerateReturnID),transactionID:AETransactionID(kAnyTransactionID))
    event.setParam(direct,forKeyword:AEKeyword(keyDirectObject));return event
}
func sendMoveEvent(_ event:NSAppleEventDescriptor)throws->NSAppleEventDescriptor{
    let reply=try event.sendEvent(options:[.waitForReply,.neverInteract,.dontRecord],timeout:2)
    if let error=reply.paramDescriptor(forKeyword:AEKeyword(keyErrorNumber)),error.int32Value != 0{throw Failure("PID-bound TextEdit AppleEvent refused (\(error.int32Value)).")}
    guard let value=reply.paramDescriptor(forKeyword:AEKeyword(keyDirectObject)) else{return NSAppleEventDescriptor.null()};return value
}
func exactAEPath(pid:Int32,url:URL)throws->NSAppleEventDescriptor{
    let document=try documentMoveSpecifier(path:url.path),paths=try sendMoveEvent(documentMoveEvent(pid:pid,eventID:OSType(kAEGetData),direct:moveProperty(0x70707468,document)))
    let values:[String]
    if paths.descriptorType==DescType(typeAEList){guard paths.numberOfItems==1,let path=paths.atIndex(1)?.stringValue else{throw Failure("Exact PID document URL is missing or ambiguous.")};values=[path]}
    else{guard let path=paths.stringValue else{throw Failure("Exact PID document URL unavailable.")};values=[path]}
    guard values==[url.path] else{throw Failure("PID document URL differs; no edit sent.")};return document
}
// Read-only capability gate: no permission UI and no edit/save dispatch.
func requireDocumentMoveCapability(expected:String,permission:(Bool)throws->Int32,path:()throws->Void,text:()throws->String?)throws{
 let code:Int32;do{code=try permission(false)}catch{throw Failure("document-move-preflight:permission:\((error as NSError).code)")}
 guard code==0 else{throw Failure("document-move-preflight:permission:\(code)")}
 do{try path()}catch{throw Failure("document-move-preflight:path:\((error as NSError).code)")}
 let actual:String?;do{actual=try text()}catch{throw Failure("document-move-preflight:text:\((error as NSError).code)")}
 guard actual==expected else{throw Failure("document-move-preflight:text:0")}
}
func preflightDocumentMove(pid:Int32,url:URL,text:String)throws{
 var address=AEAddressDesc(),target=pid
 guard AECreateDesc(DescType(typeKernelProcessID),&target,MemoryLayout<Int32>.size,&address)==noErr else{throw Failure("document-move-preflight:permission:-50")};defer{AEDisposeDesc(&address)}
 let doc=try documentMoveSpecifier(path:url.path)
 func get(_ property:OSType)throws->NSAppleEventDescriptor{
  let reply=try documentMoveEvent(pid:pid,eventID:OSType(kAEGetData),direct:moveProperty(property,doc)).sendEvent(options:[.waitForReply,.neverInteract,.dontRecord],timeout:2)
  let code=reply.paramDescriptor(forKeyword:AEKeyword(keyErrorNumber))?.int32Value ?? 0
  guard code==0 else{throw NSError(domain:"DocumentMoveAE",code:Int(code))}
  return reply.paramDescriptor(forKeyword:AEKeyword(keyDirectObject)) ?? NSAppleEventDescriptor.null()
 }
 try requireDocumentMoveCapability(expected:text,permission:{prompt in AEDeterminePermissionToAutomateTarget(&address,AEEventClass(kAECoreSuite),AEEventID(kAESave),prompt)},path:{
  let value=try get(0x70707468),paths:[String]
  if value.descriptorType==DescType(typeAEList){guard value.numberOfItems==1,let path=value.atIndex(1)?.stringValue else{throw NSError(domain:"DocumentMoveAE",code:-1728)};paths=[path]}else{paths=[value.stringValue].compactMap{$0}}
  guard paths==[url.path] else{throw NSError(domain:"DocumentMoveAE",code:-1728)}
 },text:{let value=try get(0x63747874);return value.descriptorType==DescType(typeAEList)&&value.numberOfItems==1 ? value.atIndex(1)?.stringValue:value.stringValue})
}
struct MoveDisk:Equatable{let hash:String,version:String,text:String}
func moveDisk(_ url:URL)throws->MoveDisk{
    var s=stat();guard lstat(url.path,&s)==0,(s.st_mode&S_IFMT)==S_IFREG,s.st_size<=64000,s.st_size>=0,url.standardizedFileURL.resolvingSymlinksInPath()==url else{throw Failure("Exact existing plain-text disk identity unavailable.")}
    let fd=open(url.path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);guard fd>=0 else{throw Failure("Disk descriptor unavailable.")};defer{close(fd)}
    var anchored=stat();guard fstat(fd,&anchored)==0,(anchored.st_mode&S_IFMT)==S_IFREG,anchored.st_dev==s.st_dev,anchored.st_ino==s.st_ino,anchored.st_size==s.st_size else{throw Failure("Disk identity changed before read.")}
    var bytes=Data(),buffer=[UInt8](repeating:0,count:4096)
    while true{let count=read(fd,&buffer,buffer.count);if count==0{break};guard count>0,bytes.count+count<=64000 else{throw Failure("Bounded disk read failed.")};bytes.append(contentsOf:buffer.prefix(count))}
    guard let text=String(data:bytes,encoding:.utf8),!text.contains("\0"),!text.hasPrefix("{\\rtf") else{throw Failure("Only bounded UTF-8 plain text is supported.")}
    var after=stat(),pathAfter=stat();guard fstat(fd,&after)==0,lstat(url.path,&pathAfter)==0,(pathAfter.st_mode&S_IFMT)==S_IFREG,pathAfter.st_dev==s.st_dev,pathAfter.st_ino==s.st_ino,s.st_dev==after.st_dev,s.st_ino==after.st_ino,s.st_size==after.st_size,s.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec,s.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec,s.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec,s.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec else{throw Failure("Disk changed while reading.")}
    let hash=moveHash(text);return MoveDisk(hash:hash,version:"\(s.st_dev):\(s.st_ino):\(s.st_size):\(s.st_mtimespec.tv_sec):\(s.st_mtimespec.tv_nsec):\(s.st_ctimespec.tv_sec):\(s.st_ctimespec.tv_nsec):\(hash)",text:text)
}
private struct MoveProcess:Equatable{let sec:UInt64,usec:UInt64}
private func moveProcess(_ pid:Int32)throws->MoveProcess{
    var b=proc_bsdinfo(),path=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
    guard proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&b,Int32(MemoryLayout<proc_bsdinfo>.size))==MemoryLayout<proc_bsdinfo>.size,b.pbi_pid==UInt32(pid),b.pbi_uid==getuid(),b.pbi_start_tvsec>0,
          proc_pidpath(pid,&path,UInt32(path.count))>0,String(cString:path)=="/System/Applications/TextEdit.app/Contents/MacOS/TextEdit" else{throw Failure("Exact public TextEdit process identity unavailable.")};return MoveProcess(sec:b.pbi_start_tvsec,usec:b.pbi_start_tvusec)
}
private func moveSelection(_ field:AXUIElement)->NSRange?{
    guard let raw=attribute(field,"AXSelectedTextRange"),CFGetTypeID(raw)==AXValueGetTypeID() else{return nil};var range=CFRange()
    guard AXValueGetValue(unsafeBitCast(raw,to:AXValue.self),.cfRange,&range),range.location>=0,range.length>=0 else{return nil};return NSRange(location:range.location,length:range.length)
}
private struct MoveSnapshot{
    let handle:String,pid:Int32,launch:Date,process:MoveProcess,url:URL,window:WindowCandidate,root:AXUIElement,field:AXUIElement,before:String,selection:NSRange,disk:MoveDisk,at:Date
    var json:JSON{["version":1,"controlMode":"backgroundStrict","handle":handle,"pid":Int(pid),"bundleId":"com.apple.TextEdit","processStartedAt":launch.timeIntervalSince1970,"windowId":Int(window.id),"windowTitle":window.title,"documentPath":url.path,"beforeText":before,"beforeHash":moveHash(before),"diskHash":disk.hash,"sourceRange":["location":selection.location,"length":selection.length],"observedAt":at.timeIntervalSince1970]}
}
nonisolated(unsafe) private var moveSnapshots:[String:MoveSnapshot]=[:]
private func moveField(_ root:AXUIElement)throws->AXUIElement{
    guard attribute(root,"AXModal") as? Bool != true,(attribute(root,"AXSheets") as? [AXUIElement] ?? []).isEmpty,attribute(root,"AXEnabled") as? Bool != false else{throw Failure("Document is modal, disabled or covered by a sheet.")}
    let tree=Tree();tree.build(from:root)
    let fields=tree.elements.values.filter{string($0,"AXRole")=="AXTextArea" && (string($0,"AXSubrole") ?? "").isEmpty}
    guard fields.count==1,attribute(fields[0],"AXEnabled") as? Bool != false else{throw Failure("One enabled document text field is required.")};return fields[0]
}
func observeDocumentMove(_ args:JSON)throws->JSON{
    try checkBackgroundSession()
    guard let appValue=args["app"] as? String,let pid=Int32(appValue),pid>0,let app=NSRunningApplication(processIdentifier:pid),app.bundleIdentifier=="com.apple.TextEdit",let launch=app.launchDate,
          let path=args["path"] as? String,let windowID=args["windowId"] as? Int,windowID>0 else{throw Failure("Exact TextEdit PID/path/window is required.")}
    try requireBackgroundTarget(target:pid,foreground:focusedApplicationPID());let process=try moveProcess(pid),url=try documentURL(path),root=try documentWindow(pid:pid,url:url),window=try windowForAX(root,pid:pid)
    guard Int(window.id)==windowID else{throw Failure("Exact document window differs.")}
    let field=try moveField(root),disk=try moveDisk(url)
    guard let text=string(field,"AXValue"),(text as NSString).length<=2000,text==disk.text,let selection=moveSelection(field),selection.length>0,Range(selection,in:text) != nil else{throw Failure("Observe a nonempty selection in a saved plain-text document up to 2000 UTF-16 units.")}
    try preflightDocumentMove(pid:pid,url:url,text:text)
    guard try moveProcess(pid)==process,try moveDisk(url)==disk,string(field,"AXValue")==text,moveSelection(field)==selection,documentPath(root)==url.path else{throw Failure("Document changed during read-only capability check.")}
    try checkBackgroundSession();try requireBackgroundTarget(target:pid,foreground:focusedApplicationPID())
    let snap=MoveSnapshot(handle:UUID().uuidString,pid:pid,launch:launch,process:process,url:url,window:window,root:root,field:field,before:text,selection:selection,disk:disk,at:Date())
    if moveSnapshots.count>=128,let oldest=moveSnapshots.values.min(by:{$0.at<$1.at}){moveSnapshots.removeValue(forKey:oldest.handle)}
    moveSnapshots[snap.handle]=snap;return snap.json
}
private func validateMove(_ args:JSON)throws->MoveSnapshot{
    try checkBackgroundSession()
    guard let handle=args["handle"] as? String,let snap=moveSnapshots[handle],args["app"] as? String==String(snap.pid),Date().timeIntervalSince(snap.at)>=0,Date().timeIntervalSince(snap.at)<120,
          let app=NSRunningApplication(processIdentifier:snap.pid),app.bundleIdentifier=="com.apple.TextEdit",app.launchDate==snap.launch,try moveProcess(snap.pid)==snap.process else{throw Failure("Document move observation expired or changed.")}
    try requireBackgroundTarget(target:snap.pid,foreground:focusedApplicationPID())
    let root=try documentWindow(pid:snap.pid,url:snap.url),window=try windowForAX(root,pid:snap.pid),field=try moveField(root)
    guard window.id==snap.window.id,documentPath(root)==snap.url.path else{throw Failure("Exact document URL/window changed.")}
    let disk=try moveDisk(snap.url);guard disk==snap.disk else{throw Failure("Saved document version changed.")}
    try requireDocumentMoveVersion(before:snap.before,current:string(field,"AXValue"),source:snap.selection,currentSelection:moveSelection(field),diskHash:snap.disk.hash,currentDiskHash:disk.hash)
    return snap
}
func validateDocumentMove(_ args:JSON)throws->JSON{try validateMove(args).json}
func backgroundDocumentMove(_ args:JSON)throws->JSON{
    guard Set(args.keys)==Set(["app","handle","destinationOffset","backupPath"]),let offset=args["destinationOffset"] as? Int,let backupPath=args["backupPath"] as? String else{throw Failure("Exact observed document move and backup are required.")}
    let snap=try validateMove(args),next=try movedDocumentText(snap.before,source:snap.selection,destination:offset)
    let backup=URL(fileURLWithPath:backupPath).standardizedFileURL
    guard backup.deletingLastPathComponent()==snap.url.deletingLastPathComponent(),backup.lastPathComponent.hasPrefix(snap.url.lastPathComponent+".vunemi-before-move-"),(try moveDisk(backup)).text==snap.before else{throw Failure("Verified exact before-version backup is required.")}
    let foreground=focusedApplicationPID();guard let cursor=CGEvent(source:nil)?.location else{throw Failure("Cursor verification unavailable.")}
    var address=AEAddressDesc(),target=snap.pid
    guard AECreateDesc(DescType(typeKernelProcessID),&target,MemoryLayout<Int32>.size,&address)==noErr else{throw Failure("PID automation address unavailable.")};defer{AEDisposeDesc(&address)}
    guard AEDeterminePermissionToAutomateTarget(&address,AEEventClass(kAECoreSuite),AEEventID(kAESave),false)==noErr else{throw Failure("TextEdit Automation permission unavailable; no edit sent.")}
    _ = try validateMove(args)
    guard foreground==focusedApplicationPID(),cursor==CGEvent(source:nil)?.location else{throw Failure("User environment changed before edit.")}
    let document=try exactAEPath(pid:snap.pid,url:snap.url)
    // Prove this exact PID document exposes the same text BEFORE the AX edit.
    let aeText=try sendMoveEvent(documentMoveEvent(pid:snap.pid,eventID:OSType(kAEGetData),direct:moveProperty(0x63747874,document)))
    let actual=aeText.descriptorType==DescType(typeAEList) && aeText.numberOfItems==1 ? aeText.atIndex(1)?.stringValue:aeText.stringValue
    guard actual==snap.before else{throw Failure("PID document text differs; no edit sent.")}
    _ = try validateMove(args)
    guard foreground==focusedApplicationPID(),cursor==CGEvent(source:nil)?.location else{throw Failure("Environment changed before edit.")}
    let editRoot=try documentWindow(pid:snap.pid,url:snap.url),editWindow=try windowForAX(editRoot,pid:snap.pid),editField=try moveField(editRoot)
    guard editWindow.id==snap.window.id else{throw Failure("Document window changed before edit.")}
    try requireDocumentMoveVersion(before:snap.before,current:string(editField,"AXValue"),source:snap.selection,currentSelection:moveSelection(editField),diskHash:snap.disk.hash,currentDiskHash:moveDisk(snap.url).hash)
    moveSnapshots.removeValue(forKey:snap.handle)
    let operationId=UUID().uuidString
    var result:JSON=["status":"unknown","operationId":operationId,"pid":Int(snap.pid),"bundleId":"com.apple.TextEdit","processStartedAt":snap.launch.timeIntervalSince1970,"windowId":Int(snap.window.id),"beforeHash":moveHash(snap.before),"afterHash":moveHash(next),"backupHash":moveHash(snap.before),"documentPath":snap.url.path,"backupPath":backup.path,"method":"semantic-document-move","atomicExternalCAS":false,"textLength":(snap.before as NSString).length,"sourceRange":["location":snap.selection.location,"length":snap.selection.length],"destinationOffset":offset]
    // No external-app atomic CAS exists. Immediate preconditions narrow the race;
    // the approved backup and independent postconditions do not claim to lock a user out.
    var phase="edit"
    let delivery=AXUIElementSetAttributeValue(editField,"AXValue" as CFString,next as CFString)
    do{
        guard delivery == .success,string(editField,"AXValue")==next,try moveProcess(snap.pid)==snap.process,documentPath(editRoot)==snap.url.path,
              foreground==focusedApplicationPID(),cursor==CGEvent(source:nil)?.location else{throw Failure("Post-edit readback uncertain; no save sent.")}
        let disk=try moveDisk(snap.url);guard disk.hash==snap.disk.hash || disk.text==next else{throw Failure("Disk changed after edit; no save sent.")}
        _ = try exactAEPath(pid:snap.pid,url:snap.url)
        let beforeSave=try sendMoveEvent(documentMoveEvent(pid:snap.pid,eventID:OSType(kAEGetData),direct:moveProperty(0x63747874,document)))
        let saveText=beforeSave.descriptorType==DescType(typeAEList) && beforeSave.numberOfItems==1 ? beforeSave.atIndex(1)?.stringValue:beforeSave.stringValue
        guard saveText==next,string(editField,"AXValue")==next,foreground==focusedApplicationPID(),cursor==CGEvent(source:nil)?.location else{throw Failure("Document changed before save; no save sent.")}
        phase="save"
        _ = try sendMoveEvent(documentMoveEvent(pid:snap.pid,eventID:OSType(kAESave),direct:document))
        phase="readback"
        let saved=try moveDisk(snap.url),currentRoot=try documentWindow(pid:snap.pid,url:snap.url),currentWindow=try windowForAX(currentRoot,pid:snap.pid),currentField=try moveField(currentRoot)
        guard try moveProcess(snap.pid)==snap.process,currentWindow.id==snap.window.id,string(currentField,"AXValue")==next,saved.text==next else{throw Failure("Saved field/disk identity is not verified.")}
        result["diskHash"]=saved.hash
        if foreground==focusedApplicationPID(),cursor==CGEvent(source:nil)?.location,(try? checkBackgroundSession()) != nil{result["status"]="saved"}
    }catch{result["deliveryUnknown"]=true;result["reasonCode"]="document-move-unverified";result["phase"]=phase}
    result["foregroundChanged"]=foreground != focusedApplicationPID();result["cursorChanged"]=cursor != CGEvent(source:nil)?.location
    return result
}
