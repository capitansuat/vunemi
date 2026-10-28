// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VunemiHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "DragCancellation", path: "Sources/DragCancellation", publicHeadersPath: "include"),
        .executableTarget(
            name: "VunemiHelper",
            dependencies: ["DragCancellation"],
            path: "Sources/VunemiHelper",
            exclude: ["Info.plist"],
            linkerSettings: [
                // A command-line tool has no bundle, so TCC reads its usage
                // strings from this section. Without them macOS terminates the
                // process the moment it touches a calendar.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/VunemiHelper/Info.plist",
                ])
            ]
        ),
        .testTarget(name: "VunemiHelperTests", dependencies: ["VunemiHelper"])
    ]
)
