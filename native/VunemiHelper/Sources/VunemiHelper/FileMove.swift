// Semantic same-volume file move. No GUI/input. RENAME_EXCL prevents destination
// overwrite atomically; immediate source checks are not a kernel source-version CAS.
import Foundation
import CryptoKit
import Darwin
private struct MoveRefusal:Error{let code:String}
private func moveRequire(_ ok:Bool,_ code:String)throws{if !ok{throw MoveRefusal(code:code)}}
private let moveLimit:Int64=256*1024*1024
private func moveStat(_ fd:Int32)throws->stat{var s=stat();try moveRequire(fstat(fd,&s)==0,"stat-unavailable");return s}
private func moveNS(_ t:timespec)->String{String(Int64(t.tv_sec)*1_000_000_000+Int64(t.tv_nsec))}
func fileMoveIdentity(_ fd:Int32)throws->[String:String]{let before=try moveStat(fd);try moveRequire(before.st_mode&S_IFMT==S_IFREG && before.st_size>=0 && before.st_size<=moveLimit,"source-not-bounded-regular-file");try moveRequire(lseek(fd,0,SEEK_SET)==0,"read-unavailable");var hash=SHA256(),buf=[UInt8](repeating:0,count:65536),total:Int64=0;while true{let n=read(fd,&buf,buf.count);if n<0{throw MoveRefusal(code:"read-unavailable")};if n==0{break};total+=Int64(n);try moveRequire(total<=moveLimit,"source-too-large");hash.update(data:Data(buf[0..<n]))};let after=try moveStat(fd);try moveRequire(before.st_dev==after.st_dev && before.st_ino==after.st_ino && before.st_size==after.st_size && moveNS(before.st_mtimespec)==moveNS(after.st_mtimespec) && moveNS(before.st_ctimespec)==moveNS(after.st_ctimespec) && total==after.st_size,"source-changed");return ["device":String(after.st_dev),"inode":String(after.st_ino),"size":String(after.st_size),"mtimeNs":moveNS(after.st_mtimespec),"ctimeNs":moveNS(after.st_ctimespec),"sha256":hash.finalize().map{String(format:"%02x",$0)}.joined()]}
private func moveDirectory(_ fd:Int32,_ path:String)throws->JSON{let s=try moveStat(fd);try moveRequire(s.st_mode&S_IFMT==S_IFDIR,"parent-not-directory");return ["path":path,"device":String(s.st_dev),"inode":String(s.st_ino),"uid":Int(s.st_uid),"mode":Int(s.st_mode)]}
private func movePath(_ raw:String)throws->[String]{try moveRequire(raw.hasPrefix("/") && !raw.contains("\0") && raw.utf8.count<=4096,"invalid-path");let components=raw.split(separator:"/",omittingEmptySubsequences:false).map(String.init);try moveRequire(components.count>=2 && components.first=="" && !components.dropFirst().contains(where:{$0.isEmpty||$0=="."||$0==".."}),"invalid-path");return Array(components.dropFirst())}
private func moveJSONEqual(_ a:JSON,_ b:JSON)->Bool{NSDictionary(dictionary:a).isEqual(to:b)}
private func moveOpenParent(_ path:String,_ expected:[JSON])throws->Int32{let components=try movePath(path);try moveRequire(expected.count==components.count,"parent-binding-invalid");var fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);try moveRequire(fd>=0,"parent-unavailable");do{try moveRequire(moveJSONEqual(try moveDirectory(fd,"/"),expected[0]),"parent-changed");var built="";for (i,c) in components.dropLast().enumerated(){built+="/"+c;let next=openat(fd,c,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);try moveRequire(next>=0,"parent-changed");close(fd);fd=next;try moveRequire(moveJSONEqual(try moveDirectory(fd,built),expected[i+1]),"parent-changed")};return fd}catch{close(fd);throw error}}
private func moveNoEntry(_ fd:Int32,_ name:String)throws{var s=stat();if fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW)==0{throw MoveRefusal(code:"destination-exists")};try moveRequire(errno==ENOENT,"destination-unavailable")}
/// All failures after successful rename are unknown; no rollback/retry is attempted.
func safeFileMove(_ args:JSON,beforeRename:(()throws->Void)?=nil,afterRename:(()throws->Void)?=nil)->JSON{
 var sourceFD:Int32 = -1,destinationFD:Int32 = -1,fileFD:Int32 = -1,renamed=false
 defer{if fileFD>=0{close(fileFD)};if sourceFD>=0{close(sourceFD)};if destinationFD>=0{close(destinationFD)}}
 do{
  guard let source=args["source"] as? String,let destination=args["destination"] as? String,let expected=args["sourceIdentity"] as? [String:String],Set(expected.keys)==Set(["device","inode","size","mtimeNs","ctimeNs","sha256"]),let sp=args["sourceParents"] as? [JSON],let dp=args["destinationParents"] as? [JSON],let operation=args["operationId"] as? String,UUID(uuidString:operation) != nil,let owner=args["ownerId"] as? String,!owner.isEmpty,owner.utf8.count<=160 else{throw MoveRefusal(code:"invalid-request")}
  let sc=try movePath(source),dc=try movePath(destination);try moveRequire(source != destination,"same-path")
  sourceFD=try moveOpenParent(source,sp);destinationFD=try moveOpenParent(destination,dp)
  fileFD=openat(sourceFD,sc.last!,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);try moveRequire(fileFD>=0,"source-unavailable")
  let observed=try fileMoveIdentity(fileFD);try moveRequire(observed==expected,"source-changed");try moveRequire(try moveStat(destinationFD).st_dev == moveStat(fileFD).st_dev,"cross-volume-unsupported");try moveNoEntry(destinationFD,dc.last!)
  // Reopen absolute bindings immediately before syscall; anchored FDs prevent symlink traversal.
  let sr=try moveOpenParent(source,sp);close(sr);let dr=try moveOpenParent(destination,dp);close(dr)
  var entry=stat();try moveRequire(fstatat(sourceFD,sc.last!,&entry,AT_SYMLINK_NOFOLLOW)==0 && String(entry.st_dev)==expected["device"] && String(entry.st_ino)==expected["inode"] && String(entry.st_size)==expected["size"] && moveNS(entry.st_mtimespec)==expected["mtimeNs"] && moveNS(entry.st_ctimespec)==expected["ctimeNs"],"source-changed")
  try beforeRename?()
  if renameatx_np(sourceFD,sc.last!,destinationFD,dc.last!,UInt32(RENAME_EXCL)) != 0{throw MoveRefusal(code:errno==EEXIST ? "destination-exists":errno==EXDEV ? "cross-volume-unsupported":"rename-refused")}
  renamed=true
  try afterRename?()
  let destinationFile=openat(destinationFD,dc.last!,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);try moveRequire(destinationFile>=0,"postcondition-unavailable");defer{close(destinationFile)}
  let actual=try fileMoveIdentity(destinationFile);try moveRequire(actual["device"]==expected["device"] && actual["inode"]==expected["inode"] && actual["size"]==expected["size"] && actual["sha256"]==expected["sha256"],"postcondition-mismatch")
  try moveNoEntry(sourceFD,sc.last!)
  let sourceAfter=try moveOpenParent(source,sp);close(sourceAfter);let destinationAfter=try moveOpenParent(destination,dp);close(destinationAfter)
  try moveRequire(fsync(sourceFD)==0 && fsync(destinationFD)==0,"postcommit-durability-unavailable")
  return ["status":"moved"]
 }catch{let code=(error as? MoveRefusal)?.code ?? "move-failed";return ["status":renamed ? "unknown":"not-moved","reasonCode":code]}
}
