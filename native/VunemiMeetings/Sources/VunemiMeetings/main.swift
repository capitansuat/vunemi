// VunemiMeetings — lets an assistant the user connected (Claude, Codex) read
// the meetings Vunemi recorded, over the Model Context Protocol on stdin and
// stdout. It reads Vunemi's files and nothing else: no network, no writing, no
// other folder. The user's switch in Vunemi decides whether it answers at all.
import Foundation

/// Vunemi's data folder; --data names another one (a development build keeps its own).
func dataFolder(_ arguments: [String]) -> URL {
    if let flag = arguments.firstIndex(of: "--data"), flag + 1 < arguments.count {
        return URL(fileURLWithPath: arguments[flag + 1], isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Vunemi", isDirectory: true)
}

let server = Server(library: Library(dataDir: dataFolder(CommandLine.arguments)))
while let line = readLine() {
    // A request is a few hundred bytes; nothing honest is larger than this.
    guard let bytes = line.data(using: .utf8), !bytes.isEmpty, bytes.count <= 1_048_576 else { continue }
    if let answer = server.answer(bytes) {
        FileHandle.standardOutput.write(answer)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}
