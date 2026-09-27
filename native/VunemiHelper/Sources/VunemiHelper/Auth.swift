// Asks macOS whether the person at the Mac is its owner: Touch ID, an Apple
// Watch, or the login password, in the system's own dialog.
//
// This is the app lock's door, not the vault's key. The vault is encrypted
// whether or not the lock is on; the lock decides only whether Vunemi's window
// answers. Vunemi never sees the password: macOS asks for it and tells us yes
// or no.

import Foundation
import LocalAuthentication

private final class Outcome: @unchecked Sendable {
    var ok = false
    var reason = "failed"
}

/// `reason` is the line macOS shows under its own title, in the user's language.
func authenticateOwner(reason: String) -> JSON {
    let context = LAContext()
    var unavailable: NSError?
    // deviceOwnerAuthentication, not the biometrics-only policy: a Mac with
    // no Touch ID, or a closed lid, still has a password. A lock that only
    // opens with a finger would lock those people out.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
        return ["ok": false, "reason": "unavailable", "detail": unavailable?.localizedDescription ?? ""]
    }

    let outcome = Outcome()
    let waiter = DispatchSemaphore(value: 0)
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        outcome.ok = success
        if let error = error as? LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel: outcome.reason = "cancelled"
            case .authenticationFailed: outcome.reason = "failed"
            case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled: outcome.reason = "unavailable"
            default: outcome.reason = "failed"
            }
        }
        waiter.signal()
    }
    // A person is deciding; give them time, but not forever.
    guard waiter.wait(timeout: .now() + 120) == .success else {
        context.invalidate()
        return ["ok": false, "reason": "timeout"]
    }
    return outcome.ok ? ["ok": true] : ["ok": false, "reason": outcome.reason]
}
