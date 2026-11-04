# Vunemi

Vunemi is a personal assistant for the Mac that runs on local models. Your
files, mail and calendar stay on your computer; the model runs there too.

It can use its built-in engine or a local model server you already have
(LM Studio, Ollama, llama.cpp). Files, calendar, mail, the browser, flight
and hotel search and Mac apps are offered as connections, and every
connection starts switched off.
Anything beyond reading goes through an approval card first.

Vunemi never types passwords, card or ID numbers for you, never solves
CAPTCHAs, never pays, and never deletes anything for good. macOS permission
prompts and Vunemi's own approval cards are always yours to answer.

## Download

The latest build is on the [Releases](../../releases) page: a disk image for
Apple Silicon Macs (macOS 14 or later). Open it and drag Vunemi into the
Applications folder.

This build is signed but not yet notarized by Apple, so macOS blocks it the
first time you open it. If you trust the file:

1. Try to open it. When the warning appears, choose **Done**.
2. Open **System Settings › Privacy & Security** and scroll down to
   **Security**.
3. Next to the message that the file was blocked, click **Open Anyway**. The
   button is there only after you have tried to open the file; if it has
   gone, try once more.
4. macOS asks again, and may ask for your Mac password or Touch ID.

If there is no **Open Anyway** button, check in the same Security section
where macOS allows apps from: if only the App Store is selected, choose the
App Store and known developers, then try again. macOS may block the disk
image and, later, Vunemi itself; the steps are the same.

After an update macOS may ask for your login password when Vunemi opens.
That is the Keychain, where Vunemi keeps the key to its vault: macOS
recognises the helper that reads this key by its exact code, and asks once
when an update changes it. Choose **Always Allow** and it will not ask again
until the helper changes. Vunemi never sees the password.

## Building from source

You need macOS 14+, an Apple Silicon Mac, Xcode command line tools,
Node 22+ and pnpm 11.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
```

Test macOS permissions in a packaged build rather than the development
window:

```bash
bash scripts/package.sh
open ~/.vunemi-build/mac-arm64/Vunemi.app
```

### Linux (preview)

A first Linux build (x64; arm64 when built on an arm64 machine) has
everything that does not need macOS itself: chat and tasks with approval
cards, files, mail over IMAP/Gmail/Outlook, the browser, connectors and MCP,
scheduled tasks, memory, the vault and local models. Mac apps, Shortcuts,
desktop control, Calendar and Reminders, meeting recording, the app lock
and add-ons say in the app that they are not on Linux yet.

The vault keeps its key in your desktop's keyring (GNOME Keyring or
KWallet). Without one it stores nothing. Reading PDFs uses `pdftotext`
(poppler-utils). Vunemi does not update itself on Linux yet.

To build an AppImage and a .deb you need Node 22+, pnpm 11, git, cmake
and a C++ compiler:

```bash
pnpm install
pnpm typecheck
pnpm test
bash scripts/package-linux.sh
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md)
first; every commit needs a `Signed-off-by` line.

## License

Vunemi is free software under the [GNU General Public License v3.0](LICENSE).
You may use, study, change and share it; if you distribute a changed version,
you must share its source under the same license.

The name "Vunemi" and its logo are not covered by that license. See
[TRADEMARKS.md](TRADEMARKS.md).
