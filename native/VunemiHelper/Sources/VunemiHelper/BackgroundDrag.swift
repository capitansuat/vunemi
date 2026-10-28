import AppKit
import ApplicationServices
import Darwin
import DragCancellation

struct SliderDragState:Equatable {
 let current:Double,min:Double,max:Double,frame:WindowBounds,thumb:WindowBounds
 var json:JSON { ["kind":"slider","current":current,"min":min,"max":max,"axis":"horizontal","geometry":["x":frame.x,"y":frame.y,"width":frame.width,"height":frame.height,"thumbX":thumb.x,"thumbY":thumb.y,"thumbWidth":thumb.width,"thumbHeight":thumb.height],"valueTolerance":(max-min)/(frame.width-thumb.width-2)] }
}
struct SliderDragPlan {let source:CGPoint,destination:CGPoint,tolerance:Double}
enum SliderDragPhase:Equatable {case down,move,up}
struct SliderGestureResult {
 let uncertain:Bool,cleanup:String,phase:String?,reasonCode:String?
 init(uncertain:Bool,cleanup:String,phase:String?=nil,reasonCode:String?=nil){self.uncertain=uncertain;self.cleanup=cleanup;self.phase=phase;self.reasonCode=reasonCode}
}
struct SliderGuardFailure:Error {let code:String}
let sliderFailureCodes:Set<String>=["stopped","drag-expired","session-unavailable","target-identity-changed","target-label-changed","slider-value-unavailable","slider-progress-changed","environment-changed","point-unavailable","event-creation-failed","guard-or-post-failed","post-observation-unavailable","foreground-changed","cursor-changed","drag-delivery-unverified"]
func sliderFailureCode(_ error:Error)->String {guard let failure=error as? SliderGuardFailure,sliderFailureCodes.contains(failure.code) else{return "guard-or-post-failed"};return failure.code}
func checkedSliderGuard(_ code:String,_ check:()throws->Void)throws{do{try check()}catch{throw SliderGuardFailure(code:code)}}
func sliderDragPlan(_ s:SliderDragState,expected:Double,requested:Double)throws->SliderDragPlan {
 let f=s.frame,t=s.thumb
 guard [s.current,s.min,s.max,expected,requested,f.x,f.y,f.width,f.height,t.x,t.y,t.width,t.height].allSatisfy({$0.isFinite}),s.min<s.max,s.current==expected,s.current>=s.min,s.current<=s.max,requested>=s.min,requested<=s.max,requested != expected,f.width>=40,f.width<=2000,f.height>=t.height,t.width>=4,t.width<=100,t.height>0 else{throw Failure("The observed slider value, range or geometry is invalid; no drag sent.")}
 // Measured horizontal NSSlider fixture profile: AX bounds include one point
 // outside each track edge. Other styles/apps are not granted this mapping.
 let travel=f.width-t.width-2,source=CGPoint(x:t.x+t.width/2,y:t.y+t.height/2)
 guard travel>=20,t.x>=f.x,t.y>=f.y,t.x+t.width<=f.x+f.width,t.y+t.height<=f.y+f.height,abs(source.y-(f.y+f.height/2))<=0.5,abs(source.x-(f.x+1+t.width/2+(s.current-s.min)/(s.max-s.min)*travel))<=0.5 else{throw Failure("This slider does not match the measured track/indicator geometry; no drag sent.")}
 return SliderDragPlan(source:source,destination:CGPoint(x:f.x+1+t.width/2+(requested-s.min)/(s.max-s.min)*travel,y:source.y),tolerance:(s.max-s.min)/travel)
}
func requireSliderProgress(_ actual:Double,expected:Double,tolerance:Double)throws {
 guard actual.isFinite,expected.isFinite,tolerance.isFinite,tolerance>0,abs(actual-expected)<=tolerance+0.000001 else{throw Failure("Slider value changed outside this gesture's last observed point.")}
}
func executeSliderGesture(_ plan:SliderDragPlan,guardBefore:()throws->Void,post:(SliderDragPhase,CGPoint)throws->Void,cleanupAllowed:(CGPoint)->Bool)->SliderGestureResult {
 var pressed=false,last=plan.source,phase="down"
 do {
  try guardBefore();pressed=true;try post(.down,last)
  for n in 1...8{phase="move";try guardBefore();let next=CGPoint(x:plan.source.x+(plan.destination.x-plan.source.x)*Double(n)/8,y:plan.source.y);try post(.move,next);last=next}
  phase="up";try guardBefore();try post(.up,last);pressed=false
  return SliderGestureResult(uncertain:false,cleanup:"complete")
 }catch{
  let code=sliderFailureCode(error)
  func failed(_ cleanup:String)->SliderGestureResult{SliderGestureResult(uncertain:true,cleanup:cleanup,phase:phase,reasonCode:code)}
  if pressed {guard cleanupAllowed(last) else{return failed("unavailable")};do{try post(.up,last);return failed("complete")}catch{return failed("failed")}}
  return failed("not-needed")
 }
}

typealias WindowLocationSetter = @convention(c)(OpaquePointer,CGPoint)->Void
// Only this specifically reviewed private SPI is resolved. There is no private
// framework, focus spoofing, global HID or modifier-based routing fallback.
let sliderWindowLocationSetter:WindowLocationSetter? = dlsym(UnsafeMutableRawPointer(bitPattern:-2),"CGEventSetWindowLocation").map{unsafeBitCast($0,to:WindowLocationSetter.self)}
func sliderProfile(pid:Int32,bundle:String)->Bool {bundle=="org.scope.sliderfixture" && NSRunningApplication(processIdentifier:pid)?.localizedName=="Scope Slider Fixture" && sliderWindowLocationSetter != nil}
func readSliderState(_ element:AXUIElement)->(SliderDragState,AXUIElement)? {
 guard string(element,"AXRole")=="AXSlider",string(element,"AXIdentifier")=="scope.slider.drag.v1",(string(element,"AXSubrole") ?? "").isEmpty,attribute(element,"AXEnabled") as? Bool == true,string(element,"AXOrientation")=="AXHorizontalOrientation",let current=finiteAXNumber(attribute(element,"AXValue")),let min=finiteAXNumber(attribute(element,"AXMinValue")),let max=finiteAXNumber(attribute(element,"AXMaxValue")),let frame=axBounds(element) else{return nil}
 let indicators=children(element).filter{string($0,"AXRole")=="AXValueIndicator" && axDescendant($0,of:element)}
 guard indicators.count==1,let thumb=axBounds(indicators[0]) else{return nil}
 let state=SliderDragState(current:current,min:min,max:max,frame:frame,thumb:thumb)
 guard (try? sliderDragPlan(state,expected:current,requested:current==max ? min:max)) != nil else{return nil}
 return (state,indicators[0])
}
func sliderContained(_ state:SliderDragState,in window:WindowBounds)->Bool {
 let f=state.frame,t=state.thumb
 let numbers:[Double]=[window.x,window.y,window.width,window.height,f.x,f.y,f.width,f.height,t.x,t.y,t.width,t.height]
 guard numbers.allSatisfy({$0.isFinite}),window.width>0,window.height>0 else{return false}
 for r in [f,t] {
  guard r.width>0,r.height>0,r.x>=window.x,r.y>=window.y else{return false}
  guard r.x+r.width<=window.x+window.width,r.y+r.height<=window.y+window.height else{return false}
 }
 return true
}
func sliderHitBound(owner:Int32,expectedOwner:Int32,descendant:Bool)->Bool {owner==expectedOwner && descendant}
func sliderHitMatches(pid:Int32,element:AXUIElement,point:CGPoint)->Bool {
 let app=AXUIElementCreateApplication(pid);AXUIElementSetMessagingTimeout(app,0.05)
 var hit:AXUIElement?;guard AXUIElementCopyElementAtPosition(app,Float(point.x),Float(point.y),&hit) == .success,let hit else{return false}
 var owner:pid_t=0;guard AXUIElementGetPid(hit,&owner) == .success else{return false}
 return sliderHitBound(owner:owner,expectedOwner:pid,descendant:axDescendant(hit,of:element))
}
func observeSliderStates(pid:Int32,bundle:String,tree:Tree,window:WindowBounds)->[Int:SliderDragState] {
 guard sliderProfile(pid:pid,bundle:bundle) else{return [:]}
 return tree.elements.reduce(into:[:]){result,item in if let (state,_)=readSliderState(item.value),sliderContained(state,in:window),sliderHitMatches(pid:pid,element:item.value,point:CGPoint(x:state.thumb.x+state.thumb.width/2,y:state.thumb.y+state.thumb.height/2)){result[item.key]=state}}
}
func validateSliderDrag(_ args:JSON,observed:Observation,element:AXUIElement)throws->(SliderDragState,AXUIElement,SliderDragPlan) {
 guard sliderProfile(pid:observed.pid,bundle:observed.bundleId),let ref=args["ref"] as? Int,let cached=observed.sliders[ref],let (current,thumb)=readSliderState(element),current==cached,sliderContained(current,in:observed.window.bounds),let expected=finiteAXNumber(args["expectedValue"] as CFTypeRef?),let value=finiteAXNumber(args["value"] as CFTypeRef?) else{throw Failure("Slider snapshot, value, range or geometry changed; no input sent.")}
 return (cached,thumb,try sliderDragPlan(cached,expected:expected,requested:value))
}
func performBackgroundSliderDrag(_ args:JSON)throws->JSON {
 let (_,observed,element,_)=try validateExtendedBackground(args)
 let (state,thumb,plan)=try validateSliderDrag(args,observed:observed,element:element)
 guard let stamp=sliderWindowLocationSetter else{throw Failure("Window-local routing is unavailable; no input sent.")}
 let environment=readBackgroundEnvironment();guard environment["verified"] as? Bool==true,environment["unlocked"] as? Bool==true,let foreground=environment["foregroundPid"] as? Int,foreground != Int(observed.pid),let cursor=environment["cursor"] as? [String:Double] else{throw Failure("Verified background environment unavailable; no input sent.")}
 let started=ProcessInfo.processInfo.systemUptime,operationId=UUID().uuidString
 var expectedDuringGesture=state.current
 AXUIElementSetMessagingTimeout(element,0.05);AXUIElementSetMessagingTimeout(thumb,0.05);AXUIElementSetMessagingTimeout(observed.root,0.05)
 func identity()throws{
  try checkedSliderGuard("session-unavailable"){try checkBackgroundSession()}
  guard let running=NSRunningApplication(processIdentifier:observed.pid),running.bundleIdentifier==observed.bundleId,running.launchDate==observed.launch,sliderProfile(pid:observed.pid,bundle:observed.bundleId),let window=visibleWindows(pid:observed.pid).first(where:{$0.id==observed.window.id}),window.bounds==observed.window.bounds,let boundRoot=try? windowForAX(observed.root,pid:observed.pid),boundRoot.id==observed.window.id,boundRoot.bounds==observed.window.bounds,axDescendant(element,of:observed.root),let (now,indicator)=readSliderState(element),CFEqual(indicator,thumb),now.frame==state.frame,now.thumb.width==state.thumb.width,now.thumb.height==state.thumb.height,now.thumb.y==state.thumb.y,now.min==state.min,now.max==state.max else{throw SliderGuardFailure(code:"target-identity-changed")}
 }
 func guardBefore()throws{
  func active()throws{guard VunemiDragCancelRequested()==0 else{throw SliderGuardFailure(code:"stopped")};guard ProcessInfo.processInfo.systemUptime-started<8 else{throw SliderGuardFailure(code:"drag-expired")}}
  try active();try identity()
  try checkedSliderGuard("target-label-changed"){_ = try requireTargetLabel(args["label"] as? String,actual:string(element,"AXTitle") ?? string(element,"AXDescription") ?? string(element,"AXValue"))}
  guard let actual=finiteAXNumber(attribute(element,"AXValue")) else{throw SliderGuardFailure(code:"slider-value-unavailable")}
  try checkedSliderGuard("slider-progress-changed"){try requireSliderProgress(actual,expected:expectedDuringGesture,tolerance:plan.tolerance)}
  let fresh=readBackgroundEnvironment()
  guard fresh["verified"] as? Bool==true,fresh["unlocked"] as? Bool==true,fresh["foregroundPid"] as? Int==foreground,let actual=fresh["cursor"] as? [String:Double],actual==cursor else{throw SliderGuardFailure(code:"environment-changed")}
  try active()
 }
 var eventNumber=0
 func post(_ phase:SliderDragPhase,_ point:CGPoint)throws{
  if phase != .up,VunemiDragCancelRequested() != 0{throw SliderGuardFailure(code:"stopped")}
  guard sliderHitMatches(pid:observed.pid,element:element,point:point) else{throw SliderGuardFailure(code:"point-unavailable")}
  let type:NSEvent.EventType=phase == .down ? .leftMouseDown:phase == .up ? .leftMouseUp:.leftMouseDragged
  eventNumber+=1
  let window=observed.window.bounds,local=CGPoint(x:point.x-window.x,y:point.y-window.y)
  guard let factory=NSEvent.mouseEvent(with:type,location:NSPoint(x:point.x,y:point.y),modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:Int(observed.window.id),context:nil,eventNumber:eventNumber,clickCount:1,pressure:phase == .up ? 0:1),let event=factory.cgEvent else{throw SliderGuardFailure(code:"event-creation-failed")}
  event.location=point;event.flags=[];event.setIntegerValueField(.mouseEventWindowUnderMousePointer,value:Int64(observed.window.id));event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent,value:Int64(observed.window.id));stamp(OpaquePointer(Unmanaged.passUnretained(event).toOpaque()),local)
  if phase != .up,VunemiDragCancelRequested() != 0{throw SliderGuardFailure(code:"stopped")}
  event.postToPid(observed.pid);usleep(50_000)
  if phase == .move {expectedDuringGesture=state.min+(point.x-(state.frame.x+1+state.thumb.width/2))/(state.frame.width-state.thumb.width-2)*(state.max-state.min)}
 }
 guard VunemiDragCancelInstall()==0 else{throw Failure("Cooperative cancellation could not be installed; no drag sent.")}
 defer{VunemiDragCancelRestore();if VunemiDragCancelRequested() != 0{exit(0)}}
 // Repeat immutable baseline immediately before the first down. Subsequent
 // checks allow only this slider's own value/indicator X to move along track.
 _ = try validateSliderDrag(args,observed:observed,element:element)
 let delivery=executeSliderGesture(plan,guardBefore:guardBefore,post:post,cleanupAllowed:{point in (try? identity()) != nil && sliderHitMatches(pid:observed.pid,element:element,point:point)})
 if VunemiDragCancelRequested() != 0{return ["status":"unknown","reasonCode":"stopped","phase":delivery.phase ?? "preflight","cleanup":delivery.cleanup]}
 var result:JSON
 do{result=try describe(pid:observed.pid,part:"window",windowId:observed.window.id,background:true)}catch{result=["status":"unknown","reasonCode":"post-observation-unavailable"]}
 let after=readBackgroundEnvironment(),changed=after["foregroundPid"] as? Int != foreground,afterCursor=after["cursor"] as? [String:Double],cursorChanged=afterCursor != cursor
 let actual=finiteAXNumber(attribute(element,"AXValue")),requested=(args["value"] as? NSNumber)?.doubleValue
 result["app"]=NSRunningApplication(processIdentifier:observed.pid)?.localizedName ?? "";result["operationId"]=operationId;result["backend"]="native-ax";result["controlMode"]="backgroundStrict";result["foregroundBefore"]=foreground;result["foregroundAfter"]=after["foregroundPid"] ?? NSNull();result["foregroundChanged"]=changed;result["cursorChanged"]=cursorChanged;result["cleanup"]=delivery.cleanup
 if let actual,let requested{result["dragResult"]=["requestedValue":requested,"actualValue":actual,"tolerance":plan.tolerance]}
 if !delivery.uncertain,!changed,!cursorChanged,after["verified"] as? Bool==true,after["unlocked"] as? Bool==true,result["status"] as? String != "unknown",let actual,let requested,abs(actual-requested)<=plan.tolerance+0.000001 {result["status"]="verified"}
 else{result["status"]="unknown";result["phase"]=delivery.phase ?? "readback";result["reasonCode"]=delivery.reasonCode ?? (VunemiDragCancelRequested() != 0 ? "stopped":changed ? "foreground-changed":cursorChanged ? "cursor-changed":result["reasonCode"] as? String ?? "drag-delivery-unverified")}
 return result
}
