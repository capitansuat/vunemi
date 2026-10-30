import Foundation
import CoreGraphics

/// Never controlled in the background, whatever the role. The same list as
/// BLOCKED_BUNDLES in packages/mac/src/policy.ts, which also matches by name.
let backgroundOffLimits = [
    "com.apple.Terminal", "com.googlecode.iterm2", "co.zeit.hyper", "dev.warp.Warp", "net.kovidgoyal.kitty", "io.alacritty", "com.github.wez.wezterm",
    "com.apple.keychainaccess", "com.apple.Passwords", "com.1password", "com.agilebits.onepassword", "com.bitwarden", "com.dashlane",
    "com.github.Electron", "com.vunemi", "com.openai.codex", "com.apple.systempreferences", "com.apple.SystemSettings",
    "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.dt.Xcode",
]

/// A deliberately bounded capability set: press a plain button, set the value
/// of a plain text area or field. A subrole means a window control or a secure
/// field. No keyboard, pointer or activation fallback is authorised by a
/// successful semantic background operation.
func backgroundCapability(bundle: String, role: String, action: String, subrole: String = "") -> Bool {
    guard subrole.isEmpty, !bundle.isEmpty, !backgroundOffLimits.contains(where: { bundle.lowercased().hasPrefix($0.lowercased()) }) else { return false }
    return (role == "AXButton" && action == "press") || ((role == "AXTextArea" || role == "AXTextField") && action == "set-value")
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

private func secondsSinceHardware(_ types: [CGEventType]) -> Double {
    types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
}
/// The user's own hand on the mouse since this moment. Hardware events only: a
/// background operation posts none, so these can't be what it did.
func userMovedPointer(since started: Date) -> Bool {
    secondsSinceHardware([.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]) <= Date().timeIntervalSince(started) + 0.05
}
/// Any input from the user since this moment: a click or a key can switch apps.
func userActed(since started: Date) -> Bool {
    secondsSinceHardware([CGEventType(rawValue: UInt32.max)!]) <= Date().timeIntervalSince(started) + 0.05
}
/// The pointer moved and the user didn't move it: the operation did.
func backgroundCursorDisturbed(before: CGPoint, after: CGPoint?, userMoved: Bool) -> Bool {
    guard let after else { return true }
    return before != after && !userMoved
}
/// The front app changed and it wasn't the user going to another app. Their
/// target coming to the front stays uncertain: the operation may have raised it.
func backgroundForegroundDisturbed(before: Int32?, after: Int32?, target: Int32, userActed: Bool) -> Bool {
    guard before != after else { return false }
    guard let after, after != target else { return true }
    return !userActed
}

/// A successful AX return cannot certify an operation that disturbed user input.
func backgroundDeliveryUncertain(deliverySucceeded:Bool,foregroundChanged:Bool,cursorChanged:Bool,sessionVerified:Bool) -> Bool {
    !deliverySucceeded || foregroundChanged || cursorChanged || !sessionVerified
}
