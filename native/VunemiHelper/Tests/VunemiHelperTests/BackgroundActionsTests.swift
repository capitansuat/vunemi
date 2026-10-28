import XCTest
import CoreGraphics
@testable import VunemiHelper
final class BackgroundActionsTests:XCTestCase {
 func testEnvironmentRequiresKnownSessionForegroundAndCursor(){
  let good=backgroundEnvironment(onConsole:true,locked:false,foreground:7,cursor:CGPoint(x:1,y:2),at:100)
  XCTAssertEqual(good["verified"] as? Bool,true);XCTAssertEqual(good["unlocked"] as? Bool,true)
  for (console,locked) in [(Optional<Bool>.none,Optional<Bool>.none),(true,true),(false,false)] {XCTAssertEqual(backgroundEnvironment(onConsole:console,locked:locked,foreground:7,cursor:CGPoint.zero,at:100)["verified"] as? Bool,false)}
  XCTAssertEqual(backgroundEnvironment(onConsole:true,locked:false,foreground:nil,cursor:CGPoint.zero,at:100)["verified"] as? Bool,false)
  XCTAssertEqual(backgroundEnvironment(onConsole:true,locked:false,foreground:7,cursor:nil,at:100)["verified"] as? Bool,false)
  for pid:Int32 in [0,-1] {XCTAssertEqual(backgroundEnvironment(onConsole:true,locked:false,foreground:pid,cursor:CGPoint.zero,at:100)["verified"] as? Bool,false)}
  XCTAssertEqual(backgroundEnvironment(onConsole:true,locked:false,foreground:7,cursor:CGPoint.zero,at:Double.nan)["verified"] as? Bool,false)
 }
 func testFixtureMenuRequiresTheMeasuredNonblockingControlIdentity(){
  XCTAssertFalse(knownFixtureMenuIdentifier(nil))
  XCTAssertFalse(knownFixtureMenuIdentifier("generic-popup"))
  XCTAssertTrue(knownFixtureMenuIdentifier("scope.context-menu.v1"))
 }
 func testNumericScrollRejectsUnobservedRangeConcurrentChangeAndNonFinite(){
  XCTAssertNoThrow(try requireScrollPosition(current:0.2,expected:0.2,requested:0.6,min:0,max:1))
  for (current,expected,requested,min,max) in [(0.3,0.2,0.6,0.0,1.0),(0.2,0.2,2.0,0.0,1.0),(0.2,0.2,Double.nan,0.0,1.0),(0.2,0.2,0.6,1.0,0.0)] {XCTAssertThrowsError(try requireScrollPosition(current:current,expected:expected,requested:requested,min:min,max:max))}
 }
 func testNewNativeActionsAreRoleAndApplicationBounded(){
  XCTAssertTrue(backgroundExtendedCapability(bundle:"com.apple.TextEdit",role:"AXScrollBar",action:"scroll-position"))
  XCTAssertTrue(backgroundExtendedCapability(bundle:"org.scope.fixture",role:"AXPopUpButton",action:"menu-open"))
  XCTAssertFalse(backgroundExtendedCapability(bundle:"com.example.other",role:"AXScrollBar",action:"scroll-position"))
  XCTAssertFalse(backgroundExtendedCapability(bundle:"org.scope.fixture",role:"AXMenuItem",action:"drag"))
  XCTAssertFalse(backgroundExtendedCapability(bundle:"org.scope.fixture",role:"AXPopUpButton",action:"menu-open",subrole:"AXCloseButton"))
 }
}
