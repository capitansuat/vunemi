import XCTest
@testable import VunemiHelper
final class DocumentMoveTests:XCTestCase {
 func testMoveBothDirectionsAndUnicodeBoundaries()throws{
  XCTAssertEqual(try movedDocumentText("aa TOKEN bb END",source:NSRange(location:3,length:5),destination:12),"aa  bb TOKENEND")
  XCTAssertEqual(try movedDocumentText("aa bb TOKEN",source:NSRange(location:6,length:5),destination:0),"TOKENaa bb ")
  XCTAssertEqual(try movedDocumentText("A😀BC",source:NSRange(location:1,length:2),destination:5),"ABC😀")
  XCTAssertThrowsError(try movedDocumentText("A😀BC",source:NSRange(location:1,length:1),destination:5))
  XCTAssertThrowsError(try movedDocumentText("ABC",source:NSRange(location:0,length:1),destination:1))
  XCTAssertThrowsError(try movedDocumentText("aaaa",source:NSRange(location:0,length:1),destination:4))
 }
 func testVersionPreconditionIncludesSelectionAndSavedDisk()throws{
  XCTAssertNoThrow(try requireDocumentMoveVersion(before:"abc",current:"abc",source:NSRange(location:1,length:1),currentSelection:NSRange(location:1,length:1),diskHash:"saved",currentDiskHash:"saved"))
  XCTAssertThrowsError(try requireDocumentMoveVersion(before:"abc",current:"user",source:NSRange(location:1,length:1),currentSelection:NSRange(location:1,length:1),diskHash:"saved",currentDiskHash:"saved"))
  XCTAssertThrowsError(try requireDocumentMoveVersion(before:"abc",current:"abc",source:NSRange(location:1,length:1),currentSelection:NSRange(location:0,length:1),diskHash:"saved",currentDiskHash:"saved"))
  XCTAssertThrowsError(try requireDocumentMoveVersion(before:"abc",current:"abc",source:NSRange(location:1,length:1),currentSelection:NSRange(location:1,length:1),diskHash:"saved",currentDiskHash:"other"))
 }
 func testRawSaveEventTargetsPIDAndDocumentPathIsData()throws{
  let path="/private/tmp/a\" & do shell script.txt"
  let spec=try documentMoveSpecifier(path:path)
  let event=documentMoveEvent(pid:42,eventID:0x73617665,direct:spec)
  XCTAssertEqual(event.attributeDescriptor(forKeyword:0x61646472)?.descriptorType,0x6b706964)
  XCTAssertEqual(event.attributeDescriptor(forKeyword:0x61646472)?.data.withUnsafeBytes{$0.loadUnaligned(as:Int32.self)},42)
  XCTAssertEqual(event.eventID,0x73617665)
  XCTAssertEqual(spec.descriptorType,0x6f626a20)
  XCTAssertEqual(spec.forKeyword(0x73656c64)?.forKeyword(0x6f626a32)?.stringValue,path)
  XCTAssertFalse(String(describing:spec).contains("tell application"))
 }
 func testReadOnlyCapabilityStopsBeforeHandleForPermissionPathOrTextMismatch()throws{
  var stages=[String]()
  XCTAssertThrowsError(try requireDocumentMoveCapability(expected:"abc",permission:{prompt in XCTAssertFalse(prompt);stages.append("permission");return -1743},path:{stages.append("path")},text:{stages.append("text");return "abc"}))
  XCTAssertEqual(stages,["permission"])
  stages=[]
  XCTAssertThrowsError(try requireDocumentMoveCapability(expected:"abc",permission:{_ in 0},path:{throw NSError(domain:"PRIVATE",code:-1728)},text:{stages.append("text");return "abc"})) { error in XCTAssertEqual((error as? Failure)?.message,"document-move-preflight:path:-1728") }
  XCTAssertTrue(stages.isEmpty)
  XCTAssertThrowsError(try requireDocumentMoveCapability(expected:"abc",permission:{_ in 0},path:{},text:{"other"})) { error in XCTAssertEqual((error as? Failure)?.message,"document-move-preflight:text:0") }
  XCTAssertNoThrow(try requireDocumentMoveCapability(expected:"abc",permission:{_ in 0},path:{},text:{"abc"}))
 }
}
