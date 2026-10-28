import Foundation
/// A generic AX description must not hide the actual field/display value.
func elementLabel(title:String?,description:String?,value:String?)->String? {
 let label=title ?? description ?? value
 guard let label else { return nil }
 if let value, !value.isEmpty, value != label { return "\(label): \(value)" }
 return label
}
