import AppKit
import ApplicationServices
func requireScrollPosition(current:Double,expected:Double,requested:Double,min:Double,max:Double) throws {
 guard [current,expected,requested,min,max].allSatisfy({$0.isFinite}),min<max,current==expected,current>=min,current<=max,requested>=min,requested<=max else {throw Failure("Scroll position, range or expected value changed; no input sent.")}
}
/// Measured profiles only; the fixture is a separate controlled app, never the control plane.
func backgroundExtendedCapability(bundle:String,role:String,action:String,subrole:String="") -> Bool {
 guard subrole.isEmpty else{return false}
 if action=="scroll-position" {return ["com.apple.TextEdit","org.scope.fixture"].contains(bundle) && role=="AXScrollBar"}
 return bundle=="org.scope.fixture" && ((action=="menu-open" && role=="AXPopUpButton") || (action=="menu-select" && role=="AXMenuItem"))
}

func knownFixtureMenuIdentifier(_ identifier:String?) -> Bool {identifier=="scope.context-menu.v1"}

func finiteAXNumber(_ value:CFTypeRef?) -> Double? {
 guard let value,CFGetTypeID(value) != CFBooleanGetTypeID(),let number=value as? NSNumber,number.doubleValue.isFinite else{return nil};return number.doubleValue
}
func axDescendant(_ element:AXUIElement,of ancestor:AXUIElement) -> Bool {
 var current:AXUIElement?=element
 for _ in 0..<40 {guard let item=current else{return false};if CFEqual(item,ancestor){return true};guard let parent=attribute(item,"AXParent"),CFGetTypeID(parent)==AXUIElementGetTypeID() else{return false};current=(parent as! AXUIElement)}
 return false
}
func scrollMetadata(_ element:AXUIElement) -> JSON? {
 guard string(element,"AXRole")=="AXScrollBar",let current=finiteAXNumber(attribute(element,"AXValue")),let minimum=finiteAXNumber(attribute(element,"AXMinValue")),let maximum=finiteAXNumber(attribute(element,"AXMaxValue")),minimum<maximum,current>=minimum,current<=maximum else{return nil}
 var settable:DarwinBoolean=false;guard AXUIElementIsAttributeSettable(element,"AXValue" as CFString,&settable) == .success,settable.boolValue else{return nil}
 let axis=string(element,"AXOrientation");guard axis=="AXVerticalOrientation" || axis=="AXHorizontalOrientation" else{return nil}
 return ["current":current,"min":minimum,"max":maximum,"axis":axis=="AXVerticalOrientation" ? "vertical":"horizontal"]
}
func extendedProfile(_ observed:Observation) -> String? {
 guard let launch=observed.launch,launch.timeIntervalSince1970>0 else{return nil}
 if sliderProfile(pid:observed.pid,bundle:observed.bundleId) {return "scope-fixture-slider-v1"}
 if observed.bundleId=="com.apple.TextEdit" {return "textedit-scroll-v1"}
 if observed.bundleId=="org.scope.fixture",NSRunningApplication(processIdentifier:observed.pid)?.localizedName=="Scope Fixture" {return "scope-fixture-v1"}
 return nil
}
struct BackgroundMenuAnchor {let pid:Int32;let launch:Date?;let window:UInt32;let popup:AXUIElement;let at:Date}
nonisolated(unsafe) var backgroundMenuAnchors:[String:BackgroundMenuAnchor]=[:]
func menuAnchorKey(_ observed:Observation)->String{"\(observed.pid):\(observed.window.id)"}
func menuOwnerRef(_ element:AXUIElement,observed:Observation) -> Int? {
 guard let anchor=backgroundMenuAnchors[menuAnchorKey(observed)],anchor.pid==observed.pid,anchor.launch==observed.launch,anchor.window==observed.window.id,Date().timeIntervalSince(anchor.at)<30,axDescendant(anchor.popup,of:observed.root),axDescendant(element,of:anchor.popup) else{return nil}
 return observed.tree.elements.first(where:{CFEqual($0.value,anchor.popup)})?.key
}
func extendedBackgroundTargets(_ observed:Observation) -> [JSON] {
 guard observed.background,observed.part=="window",let profile=extendedProfile(observed) else{return []}
 return observed.tree.elements.keys.sorted().compactMap {ref in
  guard let element=observed.tree.elements[ref],let label=observed.tree.labels[ref],attribute(element,"AXEnabled") as? Bool != false,axDescendant(element,of:observed.root) else{return nil}
  let role=string(element,"AXRole") ?? "",subrole=string(element,"AXSubrole") ?? ""
  var result:JSON=["ref":ref,"role":role,"label":label,"profile":profile]
  if let state=observed.sliders[ref],let (current,_)=readSliderState(element),current==state {result["actions"]=["drag"];result["drag"]=state.json;return result}
  if backgroundExtendedCapability(bundle:observed.bundleId,role:role,action:"scroll-position",subrole:subrole),let scroll=scrollMetadata(element) {result["actions"]=["scroll-position"];result["scroll"]=scroll;return result}
  if backgroundExtendedCapability(bundle:observed.bundleId,role:role,action:"menu-open",subrole:subrole),knownFixtureMenuIdentifier(string(element,"AXIdentifier")){var names:CFArray?;if AXUIElementCopyActionNames(element,&names) == .success,let names=names as? [String],names.contains("AXShowMenu") || names.contains("AXPress"){result["actions"]=["menu-open"];result["menu"]=["kind":"popup","binding":"window-descendant","ownerRef":ref];return result}}
  if backgroundExtendedCapability(bundle:observed.bundleId,role:role,action:"menu-select",subrole:subrole),let owner=menuOwnerRef(element,observed:observed){var names:CFArray?;if AXUIElementCopyActionNames(element,&names) == .success,(names as? [String] ?? []).contains("AXPress"){result["actions"]=["menu-select"];result["menu"]=["kind":"item","binding":"window-descendant","ownerRef":owner];return result}}
  return nil
 }
}
func validateExtendedBackground(_ args:JSON) throws -> (NSRunningApplication,Observation,AXUIElement,JSON) {
 try checkBackgroundSession()
 guard let target=args["app"] as? String,let found=app(matching:target) else{throw Failure("Target app closed; no input sent.")}
 let observed=try validateObservation(args,app:found)
 guard observed.background,observed.part=="window" else{throw Failure("Exact background window snapshot required.")}
 try requireBackgroundTarget(target:observed.pid,foreground:focusedApplicationPID())
 guard let ref=args["ref"] as? Int,let element=observed.tree.elements[ref],let action=args["action"] as? String,let metadata=extendedBackgroundTargets(observed).first(where:{$0["ref"] as? Int==ref}), (metadata["actions"] as? [String] ?? []).contains(action) else{throw Failure("Unsupported or unbound extended background target; no input sent.")}
 _=try requireTargetLabel(args["label"] as? String,actual:observed.tree.labels[ref])
 if action=="drag" {_ = try validateSliderDrag(args,observed:observed,element:element)}
 if action=="scroll-position" {guard let s=scrollMetadata(element),let current=s["current"] as? Double,let min=s["min"] as? Double,let max=s["max"] as? Double,let expected=finiteAXNumber(args["expectedPosition"] as CFTypeRef?),let requested=finiteAXNumber(args["position"] as CFTypeRef?) else{throw Failure("Numeric scrollbar range/current values required.")};try requireScrollPosition(current:current,expected:expected,requested:requested,min:min,max:max)}
 return (found,observed,element,metadata)
}
func performExtendedBackground(_ args:JSON,validateOnly:Bool) throws -> JSON {
 if !validateOnly,args["action"] as? String=="drag" {return try performBackgroundSliderDrag(args)}
 var (_,observed,element,metadata)=try validateExtendedBackground(args)
 if validateOnly {var result=observed.json;result["controlMode"]="backgroundStrict";result["extendedTarget"]=metadata;return result}
 // No activation, cursor movement, key events or application-level menu fallback.
 (_,observed,element,metadata)=try validateExtendedBackground(args)
 let foreground=focusedApplicationPID();try requireBackgroundTarget(target:observed.pid,foreground:foreground);try checkBackgroundSession()
 guard let cursor=CGEvent(source:nil)?.location else{throw Failure("Cursor state unavailable; no input sent.")}
 AXUIElementSetMessagingTimeout(element,0.5)
 let action=args["action"] as! String,operationId=UUID().uuidString
 let delivery:AXError
 var owner:AXUIElement?
 if action=="scroll-position" {delivery=AXUIElementSetAttributeValue(element,"AXValue" as CFString,NSNumber(value:(args["position"] as! NSNumber).doubleValue))}
 else if action=="menu-open" {
  var names:CFArray?;_ = AXUIElementCopyActionNames(element,&names)
  let method=(names as? [String] ?? []).contains("AXShowMenu") ? "AXShowMenu":"AXPress"
  backgroundMenuAnchors[menuAnchorKey(observed)]=BackgroundMenuAnchor(pid:observed.pid,launch:observed.launch,window:observed.window.id,popup:element,at:Date())
  delivery=AXUIElementPerformAction(element,method as CFString)
 }else{
  owner=backgroundMenuAnchors[menuAnchorKey(observed)]?.popup
  delivery=AXUIElementPerformAction(element,"AXPress" as CFString)
  backgroundMenuAnchors.removeValue(forKey:menuAnchorKey(observed))
 }
 usleep(50_000)
 var result:JSON
 do{result=try describe(pid:observed.pid,part:"window",windowId:observed.window.id,background:true)}catch{result=["status":"unknown","reasonCode":"post-observation-unavailable"]}
 let afterForeground=focusedApplicationPID(),afterCursor=CGEvent(source:nil)?.location
 let changed=foreground != afterForeground,cursorChanged=afterCursor == nil || cursor != afterCursor
 result["app"]=NSRunningApplication(processIdentifier:observed.pid)?.localizedName ?? "";result["operationId"]=operationId;result["backend"]="native-ax";result["controlMode"]="backgroundStrict";result["foregroundBefore"]=foreground.map{Int($0) as Any} ?? NSNull();result["foregroundAfter"]=afterForeground.map{Int($0) as Any} ?? NSNull();result["foregroundChanged"]=changed;result["cursorChanged"]=cursorChanged
 if delivery != .success || changed || cursorChanged || (try? checkBackgroundSession()) == nil || result["status"] as? String == "unknown" {result["status"]="unknown";result["reasonCode"]=changed ? "foreground-changed" : cursorChanged ? "cursor-changed" : delivery != .success ? "ax-error-\(delivery.rawValue)" : "post-observation-unavailable"}
 else if action=="scroll-position",let actual=finiteAXNumber(attribute(element,"AXValue")),let requested=finiteAXNumber(args["position"] as CFTypeRef?),abs(actual-requested)<0.000001 {result["status"]="verified";result["position"]=actual}
 else if action=="menu-select",let owner,let wanted=string(element,"AXTitle"),string(owner,"AXValue")==wanted {result["status"]="verified";result["selectedItem"]=wanted}
 else {result["status"]="delivered"}
 return result
}
