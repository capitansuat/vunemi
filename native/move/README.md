# vunemi-move

files_move's native step on Linux and Windows: the twin of the Mac helper's
`safeFileMove` (`native/VunemiHelper/Sources/VunemiHelper/FileMove.swift`).
It moves one regular file the user approved, at most 256 MB, on one volume,
and promises what the Mac does: it never replaces anything (Linux:
`renameat2(RENAME_NOREPLACE)`; Windows: `FileRenameInfoEx` without replace),
it works relative to the folders it opened one at a time without following
links (Windows: holding every folder of both chains open without
`FILE_SHARE_DELETE`, so none can be renamed or swapped meanwhile), it checks
the file is the approved one (identity and SHA-256), and anything that fails
after the rename is reported as unknown, with no rollback or retry.

`--move` reads one JSON request on stdin (`AtomicMoveRequest` without
`signal`/`assertActive`, at most 64 KB, paths at most 4096 bytes) and writes
one JSON reply. On Linux, `--journal-lock-fd 3` takes the move journal's
lock exactly as the Mac helper does; Windows locks the journal in the app.

Test hook: with `VUNEMI_MOVE_TEST_GATE=<path>` set, the program writes
`gate` to stderr right before the rename and waits until `<path>` exists
(at most 10 s). The tests use it to change things at that moment.

Built by `scripts/build-move-linux.sh` and `scripts/windows/build-move.ps1`.
