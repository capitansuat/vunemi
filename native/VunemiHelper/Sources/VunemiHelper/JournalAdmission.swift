import Foundation
import Darwin

/// Parent and child share one open-file description. Do not explicitly unlock:
/// the parent's duplicate must retain admission after this short child exits.
func exitForJournalLockModeIfRequested() {
    guard CommandLine.arguments.dropFirst().first == "--journal-lock-fd" else { return }
    var info = stat()
    guard CommandLine.arguments.count == 3, CommandLine.arguments[2] == "3",
          fstat(3, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          info.st_uid == geteuid(), info.st_mode & mode_t(0o077) == 0, info.st_nlink == 1 else {
        FileHandle.standardOutput.write(Data("{\"protocol\":1,\"locked\":false,\"reason\":\"invalid-fd\"}\n".utf8))
        Darwin.exit(64)
    }
    let result = flock(3, LOCK_EX | LOCK_NB)
    let code = errno
    let reply = result == 0 ? "{\"protocol\":1,\"locked\":true}\n" : "{\"protocol\":1,\"locked\":false,\"reason\":\"\(code == EWOULDBLOCK ? "busy" : "unavailable")\"}\n"
    FileHandle.standardOutput.write(Data(reply.utf8))
    Darwin.exit(result == 0 ? 0 : code == EWOULDBLOCK ? 75 : 74)
}
