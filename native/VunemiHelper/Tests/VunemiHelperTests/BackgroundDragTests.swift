import XCTest
import CoreGraphics
import DragCancellation
import Darwin
@testable import VunemiHelper
final class BackgroundDragTests:XCTestCase {
 let state=SliderDragState(current:25,min:0,max:100,frame:WindowBounds(x:99,y:1076,width:402,height:34),thumb:WindowBounds(x:195,y:1085,width:20,height:16))
 func testDiagnosticPreservesOriginalPhaseAndBoundedCodeThroughCleanup(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var guards=0
  let r=executeSliderGesture(p,guardBefore:{guards+=1;if guards==2{throw SliderGuardFailure(code:"slider-progress-changed")}},post:{_,_ in},cleanupAllowed:{_ in true})
  XCTAssertEqual(r.phase,"move");XCTAssertEqual(r.reasonCode,"slider-progress-changed");XCTAssertEqual(r.cleanup,"complete");XCTAssertTrue(r.uncertain)
 }
 func testDiagnosticNeverIncludesUntrustedErrorOrUnknownCode(){
  let p=try! sliderDragPlan(state,expected:25,requested:75)
  let r=executeSliderGesture(p,guardBefore:{throw Failure("private /path/document-title")},post:{_,_ in},cleanupAllowed:{_ in true})
  XCTAssertEqual(r.phase,"down");XCTAssertEqual(r.reasonCode,"guard-or-post-failed");XCTAssertEqual(r.cleanup,"not-needed")
  XCTAssertEqual(sliderFailureCode(SliderGuardFailure(code:"private /path")),"guard-or-post-failed")
 }
 func testReverseMeasuredPlanAndFirstProgressMatchReceiver(){
  let reverse=SliderDragState(current:75,min:0,max:100,frame:state.frame,thumb:WindowBounds(x:385,y:1085,width:20,height:16))
  let p=try! sliderDragPlan(reverse,expected:75,requested:40)
  XCTAssertEqual(p.source.x,395);XCTAssertEqual(p.destination.x,262)
  let first=p.source.x+(p.destination.x-p.source.x)/8
  XCTAssertEqual(first,378.375)
  let expected=(first-(reverse.frame.x+1+reverse.thumb.width/2))/(reverse.frame.width-reverse.thumb.width-2)*100
  XCTAssertEqual(expected,70.625);XCTAssertNoThrow(try requireSliderProgress(70.625,expected:expected,tolerance:p.tolerance))
 }
 func testUnpostedMoveCannotAdvanceCleanupReleasePoint(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var released:CGPoint?
  let r=executeSliderGesture(p,guardBefore:{},post:{phase,point in if phase == .move{throw Failure("cancelled before post")};if phase == .up{released=point}},cleanupAllowed:{_ in true})
  XCTAssertTrue(r.uncertain);XCTAssertEqual(released,p.source)
 }
 func testSliderAndThumbMustStayInsideExactWindowAndHitOwner(){
  XCTAssertTrue(sliderContained(state,in:WindowBounds(x:60,y:1000,width:480,height:280)))
  XCTAssertFalse(sliderContained(state,in:WindowBounds(x:100,y:1000,width:480,height:280)))
  XCTAssertTrue(sliderHitBound(owner:123,expectedOwner:123,descendant:true))
  XCTAssertFalse(sliderHitBound(owner:124,expectedOwner:123,descendant:true))
  XCTAssertFalse(sliderHitBound(owner:123,expectedOwner:123,descendant:false))
 }
 func testCooperativeSignalUsesLockFreeFlagAndRestoresHandler(){
  XCTAssertEqual(VunemiDragCancelInstall(),0);defer{VunemiDragCancelRestore()}
  XCTAssertEqual(VunemiDragCancelRequested(),0);XCTAssertEqual(raise(SIGUSR1),0);XCTAssertEqual(VunemiDragCancelRequested(),1)
 }
 func testMeasuredSliderGeometryMapsRequestedValueUsingActualThumb(){
  let p=try! sliderDragPlan(state,expected:25,requested:75)
  XCTAssertEqual(p.source,CGPoint(x:205,y:1093));XCTAssertEqual(p.destination,CGPoint(x:395,y:1093));XCTAssertEqual(p.tolerance,100.0/380,accuracy:0.000001)
 }
 func testChangedValueRangeAndUnmeasuredGeometryFailClosed(){
  XCTAssertThrowsError(try sliderDragPlan(state,expected:24,requested:75))
  XCTAssertThrowsError(try sliderDragPlan(state,expected:25,requested:101))
  XCTAssertThrowsError(try sliderDragPlan(state,expected:25,requested:Double.nan))
  let shifted=SliderDragState(current:25,min:0,max:100,frame:state.frame,thumb:WindowBounds(x:220,y:1085,width:20,height:16))
  XCTAssertThrowsError(try sliderDragPlan(shifted,expected:25,requested:75))
 }
 func testGestureStopsBeforeFurtherMovementAndBalancesOnlyBoundTarget(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var guards=0;var phases:[SliderDragPhase]=[]
  let r=executeSliderGesture(p,guardBefore:{guards+=1;if guards==2{throw Failure("stopped")}},post:{phase,_ in phases.append(phase)},cleanupAllowed:{_ in true})
  XCTAssertEqual(phases,[.down,.up]);XCTAssertTrue(r.uncertain);XCTAssertEqual(r.cleanup,"complete")
 }
 func testUnsafeCleanupCannotDispatchToChangedWindow(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var guards=0;var phases:[SliderDragPhase]=[]
  let r=executeSliderGesture(p,guardBefore:{guards+=1;if guards==2{throw Failure("window changed")}},post:{phase,_ in phases.append(phase)},cleanupAllowed:{_ in false})
  XCTAssertEqual(phases,[.down]);XCTAssertTrue(r.uncertain);XCTAssertEqual(r.cleanup,"unavailable")
 }
 func testFailedDownMayHaveLandedSoOnlyOneCleanupReleaseIsAttempted(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var phases:[SliderDragPhase]=[]
  let r=executeSliderGesture(p,guardBefore:{},post:{phase,_ in phases.append(phase);if phase == .down{throw Failure("post result lost")}},cleanupAllowed:{_ in true})
  XCTAssertEqual(phases,[.down,.up]);XCTAssertTrue(r.uncertain)
 }
 func testExternalValueChangesCannotBeMistakenForOwnPreviousPoint(){
  XCTAssertNoThrow(try requireSliderProgress(25.1,expected:25,tolerance:0.2632))
  XCTAssertThrowsError(try requireSliderProgress(26,expected:25,tolerance:0.2632))
  XCTAssertThrowsError(try requireSliderProgress(Double.nan,expected:25,tolerance:0.2632))
 }
 func testOrdinaryGestureIsBoundedAndNoopIsRefused(){
  let p=try! sliderDragPlan(state,expected:25,requested:75);var phases:[SliderDragPhase]=[]
  let r=executeSliderGesture(p,guardBefore:{},post:{phase,_ in phases.append(phase)},cleanupAllowed:{_ in true})
  XCTAssertEqual(phases.count,10);XCTAssertEqual(phases.first,.down);XCTAssertEqual(phases.last,.up);XCTAssertFalse(r.uncertain)
  XCTAssertThrowsError(try sliderDragPlan(state,expected:25,requested:25))
 }
}
