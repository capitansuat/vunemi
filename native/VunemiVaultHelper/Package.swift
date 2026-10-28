// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "VunemiVaultHelper", platforms: [.macOS(.v14)], targets: [
 .executableTarget(name: "VunemiVaultHelper"),
 .testTarget(name: "VunemiVaultHelperTests", dependencies: ["VunemiVaultHelper"])
])
