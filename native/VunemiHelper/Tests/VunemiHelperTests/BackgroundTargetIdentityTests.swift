import XCTest
@testable import VunemiHelper
final class BackgroundTargetIdentityTests:XCTestCase {
 func testExactPublicMetadataOnly(){
  let bounds=WindowBounds(x:1,y:2,width:300,height:200)
  XCTAssertTrue(validBackgroundIdentityMetadata(pid:123,requestedPID:123,window:9,requestedWindow:9,startSec:100,startUsec:7,bundle:"com.apple.TextEdit",executable:"/fixture/TextEdit",bundleExecutable:"/fixture/TextEdit",bounds:bounds))
  XCTAssertFalse(validBackgroundIdentityMetadata(pid:123,requestedPID:124,window:9,requestedWindow:9,startSec:100,startUsec:7,bundle:"com.apple.TextEdit",executable:"/fixture/TextEdit",bundleExecutable:"/fixture/TextEdit",bounds:bounds))
  XCTAssertFalse(validBackgroundIdentityMetadata(pid:123,requestedPID:123,window:9,requestedWindow:8,startSec:100,startUsec:7,bundle:"com.apple.TextEdit",executable:"/fixture/TextEdit",bundleExecutable:"/fixture/TextEdit",bounds:bounds))
  XCTAssertFalse(validBackgroundIdentityMetadata(pid:123,requestedPID:123,window:9,requestedWindow:9,startSec:0,startUsec:7,bundle:"com.apple.TextEdit",executable:"/fixture/TextEdit",bundleExecutable:"/fixture/TextEdit",bounds:bounds))
  XCTAssertFalse(validBackgroundIdentityMetadata(pid:123,requestedPID:123,window:9,requestedWindow:9,startSec:100,startUsec:7,bundle:"com.apple.TextEdit",executable:"/foreign",bundleExecutable:"/fixture/TextEdit",bounds:bounds))
 }
 func testProtectedControlPlane(){XCTAssertTrue(protectedBackgroundIdentity(bundle:"com.openai.codex",name:"Codex"));XCTAssertTrue(protectedBackgroundIdentity(bundle:"com.apple.Terminal",name:"Terminal"));XCTAssertFalse(protectedBackgroundIdentity(bundle:"com.apple.TextEdit",name:"TextEdit"))}
}
