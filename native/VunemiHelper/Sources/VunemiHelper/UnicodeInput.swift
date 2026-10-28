func unicodeInputUnits(_ text:String) -> [[UInt16]] {
 text.map { Array(String($0).utf16) }
}
func deliverUnicodeInput(_ text:String, validate:() throws -> Void, emit:([UInt16])->Void) throws {
 for units in unicodeInputUnits(text) { try validate(); emit(units) }
}
