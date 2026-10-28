import AppKit
import CoreGraphics
import Security
func requireScheduledIdle(idle:Double,counter:UInt64,expected:UInt64?)throws{
 guard idle.isFinite,idle>=10,expected == nil || expected==counter else{throw Failure("User input detected; scheduled input refused.")}
}
func requireScheduledLiteral(_ literal:String,beforeUnits:Int)throws{
 guard (literal as NSString).length>0,(literal as NSString).length<=256,beforeUnits>=0,beforeUnits+(literal as NSString).length<=2000,!literal.contains("\0") else{throw Failure("Scheduled literal or document length is outside its approved limit.")}
}
func scheduledSession()throws->(UInt32,UInt32){
 var identity:SecuritySessionId=0,attributes:SessionAttributeBits=[]
 guard SessionGetInfo(SecuritySessionId.max,&identity,&attributes)==errSecSuccess,identity>0,identity != SecuritySessionId.max,
 attributes.contains(.sessionHasGraphicAccess),!attributes.contains(.sessionIsRoot),!attributes.contains(.sessionIsRemote) else{throw Failure("Current graphical security session cannot be verified.")}
 try checkBackgroundSession();return (UInt32(getuid()),identity)
}
func scheduledEnvironment(_ idleRequired:Bool,expectedCounter:UInt64?=nil)throws->JSON{
 let (uid,identity)=try scheduledSession()
 guard let foreground=focusedApplicationPID(),let point=CGEvent(source:nil)?.location,point.x.isFinite,point.y.isFinite else{throw Failure("Current input environment unavailable.")}
 let type=CGEventType(rawValue:UInt32.max)!,counter=CGEventSource.counterForEventType(.combinedSessionState,eventType:type)
 let idle=CGEventSource.secondsSinceLastEventType(.combinedSessionState,eventType:type)
 if idleRequired{try requireScheduledIdle(idle:idle,counter:UInt64(counter),expected:expectedCounter)}
 return ["uid":uid,"securitySessionId":identity,"foregroundPid":Int(foreground),"x":point.x,"y":point.y,"counter":String(counter),"idle":idle]
}
func requireScheduledEnvironmentIdentity(current:JSON,expected:JSON)throws{
 for key in ["uid","securitySessionId","foregroundPid","x","y"]{
  guard let a=current[key],let b=expected[key],String(describing:a)==String(describing:b) else{throw Failure("User environment changed; no input sent.")}
 }
}
