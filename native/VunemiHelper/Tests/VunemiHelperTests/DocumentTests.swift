import XCTest
@testable import VunemiHelper
final class DocumentTests: XCTestCase {
 func testSaveRefusesConcurrentDiskOrFieldChanges() throws {
  XCTAssertNoThrow(try requireDocumentSave(expectedField:"old\nnew",currentField:"old\nnew",expectedDiskHash:"before",currentDiskHash:"before"))
  XCTAssertThrowsError(try requireDocumentSave(expectedField:"old\nnew",currentField:"user edit",expectedDiskHash:"before",currentDiskHash:"before"))
  XCTAssertThrowsError(try requireDocumentSave(expectedField:"old\nnew",currentField:"old\nnew",expectedDiskHash:"before",currentDiskHash:"external edit"))
 }
 func testAlreadyAutosavedExactContentsAreSafeToSaveAgain() {
  XCTAssertNoThrow(try requireDocumentSave(expectedField:"new",currentField:"new",expectedDiskHash:"before",currentDiskHash:"11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437"))
 }
 func testOpenWaitsForWindowServerIdentityBeforeReturning() throws {
  var attempts=0
  let result=try waitForDocumentObservation(timeout:0.3) { attempts+=1;return attempts<3 ? nil : ["windowId":9] }
  XCTAssertEqual(result["windowId"] as? Int,9);XCTAssertEqual(attempts,3)
  XCTAssertThrowsError(try waitForDocumentObservation(timeout:0) {nil})
 }
 func testRunHandlerReceivesArgumentsWithoutExecutingThemAsSource() throws {
  let request=DocumentScriptRequest(source:"on run argv\nreturn (item 1 of argv) & \"|\" & (item 2 of argv)\nend run",arguments:["a\" & anything.txt","İstanbul 👩‍💻"])
  XCTAssertEqual(try executeDocumentScriptRequest(request),"a\" & anything.txt|İstanbul 👩‍💻")
 }
 func testSavedProofRequiresExactFieldAndDiskBytes() {
  XCTAssertTrue(documentAlreadySaved(expected:"İstanbul\nnew",field:"İstanbul\nnew",disk:"İstanbul\nnew"))
  XCTAssertFalse(documentAlreadySaved(expected:"oldnew",field:"oldnew",disk:"old"))
  XCTAssertFalse(documentAlreadySaved(expected:"oldnew",field:"user edit",disk:"oldnew"))
 }
 func testScriptArgumentsAreData() {
  let request = documentSaveScriptRequest(path:"/private/tmp/a\" & do shell script.txt",expected:"çağrı 👩‍💻")
  XCTAssertFalse(request.source.contains("do shell script"))
  XCTAssertEqual(request.arguments,["/private/tmp/a\" & do shell script.txt","çağrı 👩‍💻"])
 }
}
extension DocumentTests {
 func testSaveIdentityIgnoresChromeButNeverAnotherProcessOrWindow() {
  XCTAssertNoThrow(try requireDocumentIdentity(expectedPID:42,currentPID:42,expectedWindow:9,currentWindow:9,expectedPath:"/tmp/a.txt",currentPath:"/tmp/a.txt"))
  XCTAssertThrowsError(try requireDocumentIdentity(expectedPID:42,currentPID:43,expectedWindow:9,currentWindow:9,expectedPath:"/tmp/a.txt",currentPath:"/tmp/a.txt"))
  XCTAssertThrowsError(try requireDocumentIdentity(expectedPID:42,currentPID:42,expectedWindow:9,currentWindow:10,expectedPath:"/tmp/a.txt",currentPath:"/tmp/a.txt"))
  XCTAssertThrowsError(try requireDocumentIdentity(expectedPID:42,currentPID:42,expectedWindow:9,currentWindow:9,expectedPath:"/tmp/a.txt",currentPath:"/tmp/b.txt"))
 }
}
