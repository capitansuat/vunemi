import XCTest
@testable import VunemiVaultHelper

final class VaultProtocolTests: XCTestCase {
 func testUntrustedCallerNeverReadsOrCreatesKey() {
  var reads = 0
  let response = vaultResponse(request:["id":7,"op":"vault_key","args":["create":true]], callerAllowed:false) { _, _ in reads += 1; return [:] }
  XCTAssertEqual(reads,0)
  XCTAssertEqual(response["ok"] as? Bool,false)
  XCTAssertEqual(response["id"] as? Int,7)
 }
 func testOtherOperationsNeverTouchKey() {
  for op in ["background_set_value","authenticate","shell","caller_check",""] {
   var reads = 0
   let response = vaultResponse(request:["id":2,"op":op],callerAllowed:true) { _, _ in reads += 1;return [:] }
   XCTAssertEqual(reads,0);XCTAssertEqual(response["ok"] as? Bool,false)
  }
 }
 func testDefaultLookupDoesNotCreateAndExplicitCreateIsPassedThrough() {
  for create in [false,true] {
   var received: Bool?
   let response = vaultResponse(request:["id":4,"op":"vault_key","args":["create":create]],callerAllowed:true) { flag, interactive in XCTAssertFalse(interactive); received=flag; return ["created":flag] }
   XCTAssertEqual(received,create);XCTAssertEqual(response["ok"] as? Bool,true)
  }
  _ = vaultResponse(request:["op":"vault_key"],callerAllowed:true) { flag, interactive in XCTAssertFalse(interactive); XCTAssertFalse(flag);return [:] }
 }
 func testKeychainDenialIsOneFailureWithoutRetryOrNewKey() {
  var reads = 0
  let response = vaultResponse(request:["id":9,"op":"vault_key","args":["create":true]],callerAllowed:true) { _, _ in reads += 1;throw NSError(domain:"fixture",code:-128) }
  XCTAssertEqual(reads,1);XCTAssertEqual(response["ok"] as? Bool,false);XCTAssertNil(response["result"])
 }

 func testAuthenticationUIRequiresExplicitFlag() {
  for flag in [false,true] {
   _ = vaultResponse(request:["op":"vault_key","args":["interactive":flag]],callerAllowed:true) { _, interactive in XCTAssertEqual(interactive,flag);return [:] }
  }
 }
}
