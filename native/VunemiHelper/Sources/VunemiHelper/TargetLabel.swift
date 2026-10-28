import Foundation
func requireTargetLabel(_ expected:String?, actual:String?) throws -> String {
 guard let expected, !expected.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
       let actual, expected==actual else {
  throw Failure("Target label does not match this snapshot ref. Observe again; no input sent.")
 }
 return actual
}
