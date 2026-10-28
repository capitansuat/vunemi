import XCTest
@testable import VunemiHelper
final class UnicodeInputTests:XCTestCase {
 func testStopsBeforeTheNextCharacterWhenTheTargetIsNoLongerValid() {
  var emitted:[[UInt16]]=[];var checks=0
  XCTAssertThrowsError(try deliverUnicodeInput("235",validate:{checks+=1;if checks==2 {throw Failure("focus changed")}},emit:{emitted.append($0)}))
  XCTAssertEqual(emitted,[[50]])
 }

 func testEveryDigitGetsItsOwnKeyEvent() { XCTAssertEqual(unicodeInputUnits("235"),[[50],[51],[53]]) }
 func testPreservesGraphemesWithoutSplittingSurrogatesOrCombiningMarks() {
  XCTAssertEqual(unicodeInputUnits("A👩‍💻e\u{301}"),[[65],[0xD83D,0xDC69,0x200D,0xD83D,0xDCBB],[101,0x301]])
 }
}
