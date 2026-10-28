import AppKit
import CoreGraphics
/// This read-only result is not an input grant. Unknown identity/session is unverified.
func backgroundEnvironment(onConsole:Bool?,locked:Bool?,foreground:Int32?,cursor:CGPoint?,at:TimeInterval) -> JSON {
 let unlocked=onConsole == true && locked == false
 let position=cursor.flatMap { $0.x.isFinite && $0.y.isFinite ? ["x":Double($0.x),"y":Double($0.y)] : nil }
 return ["version":1,"observedAt":at,"foregroundPid":foreground.map{Int($0) as Any} ?? NSNull(),"cursor":position as Any? ?? NSNull(),"unlocked":unlocked,"verified":unlocked && (foreground.map{$0>0} ?? false) && position != nil && at.isFinite && at>0]
}
func readBackgroundEnvironment() -> JSON {
 let session=CGSessionCopyCurrentDictionary() as? [String:Any]
 return backgroundEnvironment(onConsole:session?["kCGSSessionOnConsoleKey"] as? Bool,locked:session == nil ? nil : (session?["CGSSessionScreenIsLocked"] as? Bool ?? false),foreground:focusedApplicationPID(),cursor:CGEvent(source:nil)?.location,at:Date().timeIntervalSince1970)
}
