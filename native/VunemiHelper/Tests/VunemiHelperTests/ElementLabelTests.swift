import XCTest
@testable import VunemiHelper
final class ElementLabelTests: XCTestCase {
 func testPreservesActualValueWhenAccessibilityDescriptionIsGeneric() {
  XCTAssertEqual(elementLabel(title:nil,description:"Edit field",value:"2,196,317"),"Edit field: 2,196,317")
  XCTAssertEqual(elementLabel(title:"5",description:"Five",value:nil),"5")
  XCTAssertEqual(elementLabel(title:nil,description:"260",value:"260"),"260")
 }
}
