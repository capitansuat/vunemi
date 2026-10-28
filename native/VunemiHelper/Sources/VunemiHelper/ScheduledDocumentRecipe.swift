import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Darwin
private let scheduledHelperRevision:String={guard let data=try? Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[0])) else{return "unavailable"};return SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}()
private struct ScheduledHandle {let at:Date,binding:JSON,literal:String,before:String,next:String,environment:JSON;let pid:Int32,window:UInt32;let path:String;let phase:String;let deadline:Double;let backupPath:String?}
nonisolated(unsafe) private var scheduledBackups=Set<String>()
nonisolated(unsafe) private var scheduledHandles=[String:ScheduledHandle]()
private func sameScheduled(_ a:JSON,_ b:JSON)->Bool{NSDictionary(dictionary:a).isEqual(to:b)}
func requireScheduledHandleAge(at:Date,now:Date=Date())throws{
 let age=now.timeIntervalSince(at)
 guard age.isFinite,age>=0,age<=5 else{throw Failure("Scheduled handle expired; no input sent.")}
}
private func scheduledField(_ pid:Int32,_ path:String,_ window:UInt32)throws->AXUIElement{
 let root=try documentWindow(pid:pid,url:URL(fileURLWithPath:path)),candidate=try windowForAX(root,pid:pid)
 guard candidate.id==window,documentPath(root)==path else{throw Failure("Scheduled document/window changed.")}
 let tree=Tree();tree.build(from:root)
 let fields=tree.elements.values.filter{string($0,"AXRole")=="AXTextArea" && (string($0,"AXSubrole") ?? "").isEmpty}
 guard fields.count==1 else{throw Failure("Exact scheduled field unavailable.")};return fields[0]
}
private func scheduledBinding(_ pid:Int32,_ path:String,_ window:UInt32)throws->(JSON,String){
 guard path.hasPrefix("/"),path.hasSuffix(".txt"),URL(fileURLWithPath:path).standardizedFileURL.resolvingSymlinksInPath().path==path else{throw Failure("Canonical existing txt required.")}
 let identity=try backgroundTargetIdentity(["app":String(pid),"windowId":Int(window)])
 guard identity["bundleId"] as? String=="com.apple.TextEdit",scheduledHelperRevision != "unavailable" else{throw Failure("Only exact TextEdit recipe is supported.")}
 let (uid,session)=try scheduledSession(),url=URL(fileURLWithPath:path),disk=try moveDisk(url),field=try scheduledField(pid,path,window)
 guard let value=string(field,"AXValue"),value==disk.text,(value as NSString).length<=2000 else{throw Failure("Document must be saved and match its field.")}
 var s=stat(),parent=stat();guard lstat(path,&s)==0,lstat(url.deletingLastPathComponent().path,&parent)==0,(parent.st_mode&S_IFMT)==S_IFDIR else{throw Failure("Document metadata unavailable.")}
 func ns(_ t:timespec)->String{String(Int64(t.tv_sec)*1_000_000_000+Int64(t.tv_nsec))}
 let binding:JSON=["target":["path":path,"pid":Int(pid),"windowId":Int(window),"bundleId":"com.apple.TextEdit","startSec":identity["startSec"]!,"startUsec":identity["startUsec"]!,"parentDevice":String(parent.st_dev),"parentInode":String(parent.st_ino)],"version":["device":String(s.st_dev),"inode":String(s.st_ino),"size":String(s.st_size),"mtimeNs":ns(s.st_mtimespec),"ctimeNs":ns(s.st_ctimespec),"sha256":disk.hash],"textUnits":(value as NSString).length,"uid":uid,"securitySessionId":session,"helperRevision":scheduledHelperRevision]
 try preflightDocumentMove(pid:pid,url:url,text:value)
 return(binding,value)
}
func scheduledRecipeTargets()throws->JSON{
 guard AXIsProcessTrusted() else{throw Failure("Accessibility permission required; no permission prompt was opened.")}
 _ = try scheduledSession();var targets=[JSON]()
 for app in NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.TextEdit"){
  let pid=app.processIdentifier,windows=attribute(AXUIElementCreateApplication(pid),"AXWindows") as? [AXUIElement] ?? []
  for root in windows.prefix(32){if let path=documentPath(root),path.hasSuffix(".txt"),let window=try? windowForAX(root,pid:pid){targets.append(["path":path,"pid":Int(pid),"windowId":Int(window.id),"title":window.title])}}
 }
 return ["targets":targets]
}
func scheduledRecipePrepare(_ args:JSON)throws->JSON{
 guard Set(args.keys).isSubset(of:Set(["app","path","windowId","literal","binding","runtime","deadline","backupPath"])),let app=args["app"] as? String,let pid=Int32(app),pid>0,let path=args["path"] as? String,let w=args["windowId"] as? UInt32,w>0,let literal=args["literal"] as? String else{throw Failure("Exact scheduled recipe input required.")}
 let runtime=args["runtime"] as? Bool ?? false
 let environment:JSON
 do{environment=try scheduledEnvironment(runtime)}catch{if runtime{return ["status":"no-input","reasonCode":"not-idle"]};throw error}
 let pair:(JSON,String)
 do{pair=try scheduledBinding(pid,path,w)}catch{if runtime{return ["status":"no-input","reasonCode":"target-drift"]};throw error}
 let(binding,before)=pair;try requireScheduledLiteral(literal,beforeUnits:(before as NSString).length)
 if let expected=args["binding"] as? JSON {guard sameScheduled(binding,expected) else{throw Failure("Approved document version changed.")}}
 if !runtime{return ["binding":binding]}
 scheduledHandles=scheduledHandles.filter{Date().timeIntervalSince($0.value.at)<5}
 scheduledBackups.formIntersection(Set(scheduledHandles.keys))
 guard scheduledHandles.count<16 else{throw Failure("Scheduled preparation capacity reached.")}
 let handle=UUID().uuidString,deadline=args["deadline"] as? Double ?? Date().timeIntervalSince1970+5
 scheduledHandles[handle]=ScheduledHandle(at:Date(),binding:binding,literal:literal,before:before,next:before+literal,environment:environment,pid:pid,window:w,path:path,phase:"append",deadline:deadline,backupPath:args["backupPath"] as? String)
 return ["binding":binding,"handle":handle]
}
private func checkedScheduledHandle(_ args:JSON,_ phase:String,consume:Bool=true)throws->ScheduledHandle{
 guard Set(args.keys)==Set(["app","handle","deadline"]),let handle=args["handle"] as? String,let snap=scheduledHandles[handle],snap.phase==phase,Date().timeIntervalSince(snap.at)<=5,args["app"] as? String==String(snap.pid),let deadline=args["deadline"] as? Double,deadline<=snap.deadline,Date().timeIntervalSince1970<deadline else{throw Failure("Scheduled handle expired or mismatched; no input sent.")}
 try requireScheduledHandleAge(at:snap.at)
 if consume{scheduledHandles.removeValue(forKey:handle)}
 try requireScheduledEnvironment(snap)
 try requireBackgroundTarget(target:snap.pid,foreground:focusedApplicationPID());return ScheduledHandle(at:snap.at,binding:snap.binding,literal:snap.literal,before:snap.before,next:snap.next,environment:snap.environment,pid:snap.pid,window:snap.window,path:snap.path,phase:snap.phase,deadline:deadline,backupPath:snap.backupPath)
}
func scheduledDocumentAppend(_ args:JSON)throws->JSON{
 let snap=try checkedScheduledHandle(args,"append"),current=try scheduledBinding(snap.pid,snap.path,snap.window)
 guard sameScheduled(current.0,snap.binding),current.1==snap.before else{throw Failure("Scheduled document changed; no append sent.")}
 guard let handle=args["handle"] as? String,scheduledBackups.remove(handle) != nil else{throw Failure("Verified backup is required.")}
 let field=try scheduledField(snap.pid,snap.path,snap.window)
 try requireScheduledEnvironment(snap)
 guard Date().timeIntervalSince1970<snap.deadline else{throw Failure("Scheduled deadline expired.")}
 try requireScheduledHandleAge(at:snap.at)
 let operation=UUID().uuidString,delivered=AXUIElementSetAttributeValue(field,"AXValue" as CFString,snap.next as CFString)
 do{
  guard delivered == .success,string(field,"AXValue")==snap.next else{throw Failure("Append postcondition unavailable.")}
  try requireScheduledEnvironment(snap)
  try requireBackgroundTarget(target:snap.pid,foreground:focusedApplicationPID())
  let handle=UUID().uuidString
  scheduledHandles[handle]=ScheduledHandle(at:Date(),binding:snap.binding,literal:snap.literal,before:snap.before,next:snap.next,environment:snap.environment,pid:snap.pid,window:snap.window,path:snap.path,phase:"save",deadline:snap.deadline,backupPath:snap.backupPath)
  return ["status":"verified","operationId":operation,"saveHandle":handle,"afterHash":moveHash(snap.next)]
 }catch{return ["status":"unknown","operationId":operation,"deliveryUnknown":true]}
}
func scheduledDocumentSave(_ args:JSON)throws->JSON{
 let snap=try checkedScheduledHandle(args,"save"),field=try scheduledField(snap.pid,snap.path,snap.window),url=URL(fileURLWithPath:snap.path)
 guard string(field,"AXValue")==snap.next else{throw Failure("Field changed before scheduled save.")}
 // Recheck the exact PID/window incarnation independently of the old file inode (autosave can replace it).
 let identity=snap.binding["target"] as! JSON
 try requireBackgroundTaskPermissionIdentity(["kind":"native-window","bundleId":"com.apple.TextEdit","pid":Int(snap.pid),"startSec":identity["startSec"]!,"startUsec":identity["startUsec"]!,"windowId":Int(snap.window),"controlMode":"backgroundStrict"],pid:snap.pid,windowId:snap.window)
 let disk=try moveDisk(url),operation=UUID().uuidString
 let approvedVersion=snap.binding["version"] as! JSON
 guard disk.text==snap.next || (disk.text==snap.before && disk.version.hasPrefix("\(approvedVersion["device"]!):\(approvedVersion["inode"]!):\(approvedVersion["size"]!):")) else{throw Failure("Disk changed after append; no save sent.")}
 var st=stat(),par=stat();guard lstat(snap.path,&st)==0,lstat(url.deletingLastPathComponent().path,&par)==0,String(par.st_dev)==identity["parentDevice"] as? String,String(par.st_ino)==identity["parentInode"] as? String else{throw Failure("Document parent changed.")}
 if disk.text==snap.before{guard String(st.st_dev)==approvedVersion["device"] as? String,String(st.st_ino)==approvedVersion["inode"] as? String,String(st.st_size)==approvedVersion["size"] as? String,String(Int64(st.st_mtimespec.tv_sec)*1_000_000_000+Int64(st.st_mtimespec.tv_nsec))==approvedVersion["mtimeNs"] as? String,String(Int64(st.st_ctimespec.tv_sec)*1_000_000_000+Int64(st.st_ctimespec.tv_nsec))==approvedVersion["ctimeNs"] as? String else{throw Failure("Before-save file version changed.")}}
 var saveSent=false
 do{
  if disk.text != snap.next {
   try preflightDocumentMove(pid:snap.pid,url:url,text:snap.next)
   try requireScheduledEnvironment(snap)
   guard Date().timeIntervalSince1970<snap.deadline else{throw Failure("Scheduled deadline expired.")}
   let document=try exactAEPath(pid:snap.pid,url:url)
   try requireScheduledEnvironment(snap)
   guard Date().timeIntervalSince1970<snap.deadline,string(field,"AXValue")==snap.next else{throw Failure("User state or deadline changed before save.")}
   let lastDisk=try moveDisk(url)
   if lastDisk.text != snap.next {
    guard lastDisk.version==disk.version else{throw Failure("Disk changed while resolving exact save target.")}
    try requireScheduledEnvironment(snap)
    guard Date().timeIntervalSince1970<snap.deadline else{throw Failure("Save deadline expired.")}
    try requireScheduledHandleAge(at:snap.at)
    saveSent=true;_ = try sendMoveEvent(documentMoveEvent(pid:snap.pid,eventID:OSType(kAESave),direct:document))
   }
  }
  let verified=try scheduledBinding(snap.pid,snap.path,snap.window)
  guard verified.1==snap.next,string(field,"AXValue")==snap.next else{throw Failure("Saved document postcondition differs.")}
  try requireScheduledEnvironment(snap)
  let observation=try describe(pid:snap.pid,part:"window",windowId:snap.window,background:true)
  let fields=(observation["targets"] as? [JSON] ?? []).filter{$0["role"] as? String=="AXTextArea"}
  guard fields.count==1,let ref=fields.first?["ref"] as? Int,let started=observation["processStartedAt"] as? Double,let title=observation["windowTitle"] as? String else{throw Failure("Verified field receipt unavailable.")}
  let evidence:JSON=["version":1,"kind":"verified-save","bundleId":"com.apple.TextEdit","processStartedAt":started,"windowId":Int(snap.window),"windowTitle":title,"fieldRef":ref,"documentPath":snap.path,"valueHash":moveHash(snap.next),"diskHash":moveHash(snap.next),"operationId":operation]
  return ["status":"verified","operationId":operation,"binding":verified.0,"afterHash":moveHash(snap.next),"saveSent":saveSent,"evidence":evidence]
 }catch{return ["status":"unknown","operationId":operation,"deliveryUnknown":true,"saveSent":saveSent]}
}

private func requireScheduledEnvironment(_ snap:ScheduledHandle)throws{
 let current=try scheduledEnvironment(true,expectedCounter:UInt64(snap.environment["counter"] as? String ?? ""))
 try requireScheduledEnvironmentIdentity(current:current,expected:snap.environment)
 try requireBackgroundTarget(target:snap.pid,foreground:focusedApplicationPID())
}
func scheduledRecipeBackup(_ args:JSON)throws->JSON{
 let snap=try checkedScheduledHandle(args,"append",consume:false)
 guard let handle=args["handle"] as? String,!scheduledBackups.contains(handle),let path=snap.backupPath,let target=snap.binding["target"] as? JSON,let dev=target["parentDevice"] as? String,let ino=target["parentInode"] as? String else{throw Failure("Exact backup recipe required.")}
 let current=try scheduledBinding(snap.pid,snap.path,snap.window);guard sameScheduled(current.0,snap.binding),current.1==snap.before else{throw Failure("Document changed before backup.")}
 try requireScheduledEnvironment(snap)
 let result=try createScheduledBackup(path:snap.path,backupPath:path,before:snap.before,parentDevice:dev,parentInode:ino,beforeCreate:{try requireScheduledHandleAge(at:snap.at)})
 if result["status"] as? String=="backup-created"{scheduledBackups.insert(handle)}else{scheduledHandles.removeValue(forKey:handle)}
 return result
}
func createScheduledBackup(path:String,backupPath:String,before:String,parentDevice:String,parentInode:String,beforeCreate:()throws->Void = {})throws->JSON{
 let source=URL(fileURLWithPath:path),parent=source.deletingLastPathComponent(),backup=URL(fileURLWithPath:backupPath)
 guard backup.deletingLastPathComponent()==parent,backup.lastPathComponent.hasPrefix(source.lastPathComponent+".vunemi-before-scheduled-"),backupPath==backup.standardizedFileURL.path else{throw Failure("Invalid backup location.")}
 let dir=open(parent.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);guard dir>=0 else{throw Failure("Backup directory unavailable.")};defer{close(dir)}
 var bound=stat();guard fstat(dir,&bound)==0,(bound.st_mode&S_IFMT)==S_IFDIR,String(bound.st_dev)==parentDevice,String(bound.st_ino)==parentInode else{throw Failure("Backup directory changed.")}
 try beforeCreate()
 var current=stat();guard lstat(parent.path,&current)==0,(current.st_mode&S_IFMT)==S_IFDIR,current.st_dev==bound.st_dev,current.st_ino==bound.st_ino,parent.resolvingSymlinksInPath()==parent else{throw Failure("Backup directory path changed.")}
 let fd=openat(dir,backup.lastPathComponent,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,mode_t(0o600));guard fd>=0 else{throw Failure("Backup exists or could not be created.")};defer{close(fd)}
 do{
  let bytes=Array(before.utf8);var offset=0
  while offset<bytes.count{let n=bytes.withUnsafeBytes{raw in Darwin.write(fd,raw.baseAddress!.advanced(by:offset),bytes.count-offset)};guard n>0 else{throw Failure("Backup write failed.")};offset+=n}
  guard fsync(fd)==0,fsync(dir)==0,lseek(fd,0,SEEK_SET)==0 else{throw Failure("Backup sync failed.")}
  var actual=[UInt8](repeating:0,count:bytes.count+1),count=0
  let capacity=actual.count
  while count<capacity{let n=actual.withUnsafeMutableBytes{raw in Darwin.read(fd,raw.baseAddress!.advanced(by:count),capacity-count)};if n==0{break};guard n>0 else{throw Failure("Backup read failed.")};count+=n}
  guard Array(actual.prefix(count))==bytes else{throw Failure("Backup verification failed.")}
  var end=stat();guard lstat(parent.path,&end)==0,end.st_dev==bound.st_dev,end.st_ino==bound.st_ino,(end.st_mode&S_IFMT)==S_IFDIR,parent.resolvingSymlinksInPath()==parent else{throw Failure("Backup directory moved after creation.")}
  return ["status":"backup-created","backupCreated":true,"path":backupPath,"sha256":moveHash(before)]
 }catch{return ["status":"backup-only","backupCreated":true,"path":backupPath,"sha256":"","reasonCode":"backup-unverified"]}
}
