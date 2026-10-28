import Foundation

/// A deliberately bounded capability set. No keyboard, pointer or activation
/// fallback is authorised by a successful semantic background operation.
func backgroundCapability(bundle: String, role: String, action: String, subrole: String = "") -> Bool {
    guard subrole.isEmpty else { return false }
    return (bundle == "com.apple.calculator" && role == "AXButton" && action == "press") ||
    (bundle == "com.apple.TextEdit" && role == "AXTextArea" && action == "set-value")
}

func requireBackgroundTarget(target: Int32, foreground: Int32?) throws {
    guard let foreground, foreground != target else {
        throw Failure("Background control yielded to the user, or foreground state is unavailable. No input sent; observe before resuming.")
    }
}

func requireBackgroundSession(onConsole: Bool?, locked: Bool?) throws {
    guard onConsole == true, locked == false else {
        throw Failure("The screen is locked or the interactive session cannot be verified. No background input sent.")
    }
}

func requireBackgroundReplacement(expected: String?, current: String?, replacement: String) throws {
    guard let expected, let current, expected == current else {
        throw Failure("The complete field value changed or is unreadable. No replacement sent; observe again.")
    }
    guard replacement.count <= 2000 else {
        throw Failure("Background replacement is limited to 2000 characters. No input sent.")
    }
}

/// NSWorkspace is the OS activation authority. AX sometimes omits its focused
/// application; an explicit disagreement or inactive/unknown workspace yields.
func verifiedForegroundPID(ax:Int32?,workspace:Int32?,workspaceActive:Bool) -> Int32? {
    guard workspaceActive,let workspace else {return nil}
    guard ax == nil || ax == workspace else {return nil}
    return workspace
}

/// A successful AX return cannot certify an operation that disturbed user input.
func backgroundDeliveryUncertain(deliverySucceeded:Bool,foregroundChanged:Bool,cursorChanged:Bool,sessionVerified:Bool) -> Bool {
    !deliverySucceeded || foregroundChanged || cursorChanged || !sessionVerified
}
