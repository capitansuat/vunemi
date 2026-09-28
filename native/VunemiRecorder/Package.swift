// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "VunemiRecorder",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "VunemiRecorder",
            path: "Sources/VunemiRecorder",
            exclude: ["Info.plist"],
            linkerSettings: [
                // A command-line tool has no bundle: TCC reads its usage
                // strings from this section of the binary.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/VunemiRecorder/Info.plist",
                ])
            ]
        )
    ]
)
