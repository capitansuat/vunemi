import XCTest
@testable import VunemiHelper
final class BackgroundControlTests: XCTestCase {
    func testCursorChangeNeverBecomesKnownBackgroundDelivery() {
        XCTAssertTrue(backgroundDeliveryUncertain(deliverySucceeded:true,foregroundChanged:false,cursorChanged:true,sessionVerified:true))
        XCTAssertTrue(backgroundDeliveryUncertain(deliverySucceeded:true,foregroundChanged:true,cursorChanged:false,sessionVerified:true))
        XCTAssertTrue(backgroundDeliveryUncertain(deliverySucceeded:false,foregroundChanged:false,cursorChanged:false,sessionVerified:true))
        XCTAssertTrue(backgroundDeliveryUncertain(deliverySucceeded:true,foregroundChanged:false,cursorChanged:false,sessionVerified:false))
        XCTAssertFalse(backgroundDeliveryUncertain(deliverySucceeded:true,foregroundChanged:false,cursorChanged:false,sessionVerified:true))
    }
    func testLockedOrUnknownSessionNeverAllowsBackgroundInput() {
        XCTAssertThrowsError(try requireBackgroundSession(onConsole: true, locked: true))
        XCTAssertThrowsError(try requireBackgroundSession(onConsole: nil, locked: nil))
        XCTAssertThrowsError(try requireBackgroundSession(onConsole: false, locked: false))
        XCTAssertNoThrow(try requireBackgroundSession(onConsole: true, locked: false))
    }
    func testUserTakingTargetBlocksFurtherDelivery() {
        XCTAssertThrowsError(try requireBackgroundTarget(target: 42, foreground: 42))
        XCTAssertThrowsError(try requireBackgroundTarget(target: 42, foreground: nil))
        XCTAssertNoThrow(try requireBackgroundTarget(target: 42, foreground: 7))
    }
    func testUnsupportedAppRoleAndActionNeverSelectForegroundFallback() {
        XCTAssertTrue(backgroundCapability(bundle: "com.apple.calculator", role: "AXButton", action: "press"))
        XCTAssertTrue(backgroundCapability(bundle: "com.apple.TextEdit", role: "AXTextArea", action: "set-value"))
        XCTAssertFalse(backgroundCapability(bundle: "com.apple.calculator", role: "AXButton", action: "key"))
        XCTAssertFalse(backgroundCapability(bundle: "com.apple.TextEdit", role: "AXMenuItem", action: "press"))
        XCTAssertFalse(backgroundCapability(bundle: "", role: "AXButton", action: "press"))
    }
    func testAnyOtherAppGetsPlainButtonsAndTextOnly() {
        XCTAssertTrue(backgroundCapability(bundle: "com.apple.Notes", role: "AXButton", action: "press"))
        XCTAssertTrue(backgroundCapability(bundle: "com.apple.Notes", role: "AXTextArea", action: "set-value"))
        XCTAssertTrue(backgroundCapability(bundle: "com.example.unknown", role: "AXTextField", action: "set-value"))
        XCTAssertFalse(backgroundCapability(bundle: "com.example.unknown", role: "AXButton", action: "set-value"))
        XCTAssertFalse(backgroundCapability(bundle: "com.example.unknown", role: "AXTextField", action: "press"))
        XCTAssertFalse(backgroundCapability(bundle: "com.example.unknown", role: "AXTextField", action: "set-value", subrole: "AXSecureTextField"))
    }
    func testOffLimitAppsGetNothing() {
        for bundle in ["com.apple.Terminal", "com.apple.Passwords", "com.vunemi.app", "com.apple.systempreferences", "com.1password.1password"] {
            XCTAssertFalse(backgroundCapability(bundle: bundle, role: "AXButton", action: "press"), bundle)
            XCTAssertFalse(backgroundCapability(bundle: bundle, role: "AXTextArea", action: "set-value"), bundle)
        }
    }
    func testWindowManagementButtonsAreNotBackgroundArithmetic() {
        XCTAssertFalse(backgroundCapability(bundle: "com.apple.calculator", role: "AXButton", action: "press", subrole: "AXCloseButton"))
        XCTAssertFalse(backgroundCapability(bundle: "com.apple.calculator", role: "AXButton", action: "press", subrole: "AXFullScreenButton"))
    }
    func testReplacementRequiresUnchangedCompleteValueAndBoundedText() {
        XCTAssertNoThrow(try requireBackgroundReplacement(expected: "İstanbul 👩‍💻", current: "İstanbul 👩‍💻", replacement: "çağrı"))
        XCTAssertThrowsError(try requireBackgroundReplacement(expected: "", current: "user wrote", replacement: "new"))
        XCTAssertThrowsError(try requireBackgroundReplacement(expected: nil, current: "", replacement: "new"))
        XCTAssertThrowsError(try requireBackgroundReplacement(expected: "", current: nil, replacement: "new"))
        XCTAssertThrowsError(try requireBackgroundReplacement(expected: "", current: "", replacement: String(repeating: "a", count: 2001)))
    }
}
extension BackgroundControlTests {
    func testForegroundUsesActiveWorkspaceWhenAXOmitsItsFocusedApp() {
        XCTAssertEqual(verifiedForegroundPID(ax:nil,workspace:7,workspaceActive:true),7)
        XCTAssertEqual(verifiedForegroundPID(ax:7,workspace:7,workspaceActive:true),7)
        XCTAssertNil(verifiedForegroundPID(ax:42,workspace:7,workspaceActive:true))
        XCTAssertNil(verifiedForegroundPID(ax:nil,workspace:7,workspaceActive:false))
        XCTAssertNil(verifiedForegroundPID(ax:7,workspace:nil,workspaceActive:false))
    }
}
