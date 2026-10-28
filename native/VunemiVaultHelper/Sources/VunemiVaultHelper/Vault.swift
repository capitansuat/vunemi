// The vault master key lives in the login keychain. This executable is built
// independently of desktop control: ordinary desktop updates cannot change its identity.
//
// Self-signed macOS clients get a cdhash Keychain partition, even with a stable
// designated requirement. Keep this broker's signed bytes unchanged when the
// desktop helper changes. Developer ID distribution uses the Apple team identity.
// The app receives the key only in its isolated Vault utility process.
//
// The one rule that matters: a new key is written only when the keychain
// says there is none. Any other answer — denied, cancelled, no UI allowed —
// is reported and nothing is written, because a fresh key would leave every
// secret encrypted with the old one unreadable for good.

import CryptoKit
import Foundation
import Security

// Only this name is ever read. Keys under names the app had before its first
// release are left alone: looking at them made the keychain ask a new user
// for their password before Vunemi had shown anything.
private let service = ownLeafHash() == nil ? "com.vunemi.vault.dev" : "com.vunemi.vault"
private let account = "master-key"
private let keyBytes = 32

private enum Lookup {
    case found(Data)
    case absent
}

private func find() throws -> Lookup {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecSuccess {
        guard let data = found as? Data, data.count == keyBytes else {
            // Never overwritten: it is someone's key, just not one we expected.
            throw Failure("Anahtar zincirindeki Kasa anahtarı beklenen biçimde değil; dokunulmadı.")
        }
        return .found(data)
    }
    guard status == errSecItemNotFound else {
        throw Failure("Anahtar zinciri Kasa anahtarını vermedi: \(describe(status))")
    }
    return .absent
}

private func store(_ data: Data) throws {
    let add: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrLabel as String: "Vunemi vault key",
        kSecValueData as String: data,
    ]
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else {
        throw Failure("Kasa anahtarı anahtar zincirine yazılamadı: \(describe(added))")
    }
}

func vaultKey(create: Bool, interactive: Bool) throws -> JSON {
    // A changed signature or locked login keychain must not hold startup hostage.
    // Only a direct user request in the Vault UI allows macOS authentication UI.
    let uiStatus = SecKeychainSetUserInteractionAllowed(interactive)
    guard uiStatus == errSecSuccess else { throw Failure("Anahtar zinciri erişimi hazırlanamadı.") }
    if case .found(let data) = try find() {
        return ["key": data.base64EncodedString(), "created": false]
    }
    guard create else { return ["key": NSNull(), "created": false] }

    var bytes = [UInt8](repeating: 0, count: keyBytes)
    guard SecRandomCopyBytes(kSecRandomDefault, keyBytes, &bytes) == errSecSuccess else {
        throw Failure("Rastgele anahtar üretilemedi.")
    }
    let data = Data(bytes)
    try store(data)
    return ["key": data.base64EncodedString(), "created": true]
}

private func describe(_ status: OSStatus) -> String {
    let text = SecCopyErrorMessageString(status, nil) as String? ?? "bilinmeyen hata"
    return "\(text) (\(status))"
}

/// Whether the process that started this helper is Vunemi's own: the app, or
/// its Vault process (which runs as Electron's "Vunemi Helper"), signed with
/// the same certificate as this helper. Any program of the same user can run
/// this helper; without this, any of them could ask it for the key. The fuses
/// (no RunAsNode, no NODE_OPTIONS, asar integrity) keep other code from
/// running under Vunemi's signature.
///
/// Ad hoc (a development build) has no certificate to compare: nothing is
/// checked, and the keychain knows such a helper only by its exact hash.
func callerIsVunemi() -> Bool {
    guard let leaf = ownLeafHash() else { return true }
    var parent: SecCode?
    let attributes = [kSecGuestAttributePid: getppid()] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &parent) == errSecSuccess, let code = parent else { return false }
    let text = "(identifier \"com.vunemi.app\" or identifier \"com.vunemi.app.helper\") and certificate leaf = H\"\(leaf)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let wanted = requirement else { return false }
    return SecCodeCheckValidity(code, [], wanted) == errSecSuccess
}

/// The SHA-1 of this helper's signing certificate, as a requirement writes it; nil when ad hoc.
private func ownLeafHash() -> String? {
    var me: SecCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let running = me else { return nil }
    var onDisk: SecStaticCode?
    guard SecCodeCopyStaticCode(running, [], &onDisk) == errSecSuccess, let code = onDisk else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let signing = info as? [String: Any],
          let chain = signing[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = chain.first else { return nil }
    let der = SecCertificateCopyData(leaf) as Data
    return Insecure.SHA1.hash(data: der).map { String(format: "%02x", $0) }.joined()
}
