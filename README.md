# Vunemi

Vunemi is a personal assistant for the Mac that runs on local models. Your
files, mail and calendar stay on your computer; the model runs there too.

It can use its built-in engine or a local model server you already have
(LM Studio, Ollama, llama.cpp). Files, calendar, mail, the browser and Mac
apps are offered as connections, and every connection starts switched off.
Anything beyond reading goes through an approval card first.

Vunemi never types passwords, card or ID numbers for you, never solves
CAPTCHAs, never pays, and never deletes anything for good. macOS permission
prompts and Vunemi's own approval cards are always yours to answer.

## Download

The latest build is on the [Releases](../../releases) page: a disk image for
Apple Silicon Macs (macOS 14 or later). Open it and drag Vunemi into the
Applications folder.

This build is signed but not yet notarized by Apple. The first time you open
it, macOS may refuse; go to **System Settings › Privacy & Security** and
click **Open Anyway**.

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
open ~/.ocak-build/mac-arm64/Vunemi.app
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
