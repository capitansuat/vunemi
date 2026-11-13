// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VunemiMeetings",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "VunemiMeetings"),
        .testTarget(name: "VunemiMeetingsTests", dependencies: ["VunemiMeetings"]),
    ]
)
