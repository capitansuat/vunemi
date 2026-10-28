import XCTest
@testable import VunemiHelper
final class TargetLabelTests:XCTestCase {
 func testRejectsAValidRefPointingToTheWrongNamedButton() {
  XCTAssertThrowsError(try requireTargetLabel("3",actual:"Add"))
  XCTAssertThrowsError(try requireTargetLabel(nil,actual:"3"))
  XCTAssertEqual(try requireTargetLabel("3",actual:"3"),"3")
 }
}
