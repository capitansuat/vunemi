// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.5.1",
  date: "2026-11-26",
  asset: "Vunemi-0.5.1-arm64.dmg",
  sizeMb: 232,
  sha256: "d61970a9bace393e94e2cc7c90c471401c3b5b69c0dd3ebcb433f8fad716439f",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.5.1-arm64.zip",
  zipSizeMb: 243,
  zipSha256: "18ace1870a2a169a81445650ed48cd771cdde3ca2e23ba1ebf687b4a29f00235",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";

// The Linux preview, a pre-release of its own (vX-linux.N). The Mac fields
// above don't depend on it. Each architecture has an AppImage and a .deb;
// an AppImage with a signature (scripts/sign-update.mjs, linux) gets the
// update feed update/linux-<arch>.json, which the AppImage updates itself
// from. A .deb never has a signature: it can't replace itself. Shape of a
// file: { kind: "appImage" | "deb", arch: "x64" | "arm64", asset, sizeMb, sha256, signature? }.
export const linuxRelease = {
  tag: "v0.5.1-linux.1",
  version: "0.5.1",
  date: "2026-11-26",
  files: [
    { kind: "appImage", arch: "x64", asset: "Vunemi-0.5.1-linux-x86_64.AppImage", sizeMb: 133, sha256: "5c8868a9fb703f0210d52c7bf27b4a8d53a00632e169742010b433241abf36eb", signature: "khoe/AIr3NeUYmWHTv88S4wIoFpf1dF/LTq2dbyw4F5BXWgOXJXb3hV8bFyefYAYilYxP+iASegcYHlW8uNtCQ==" },
    { kind: "deb", arch: "x64", asset: "Vunemi-0.5.1-linux-amd64.deb", sizeMb: 112, sha256: "16b78d17608878f9bfcf9df92cfb5534630f0add9b5b7b4596b27e145da5cdfb" },
    { kind: "appImage", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.AppImage", sizeMb: 133, sha256: "b3078afe7cc9993557add3abf54f97dad7da6d6d8cad893a427c078d319a5010", signature: "QPCJlDkiOeN9TwKQF81LBCPNB2MpY1cgAv/Qz59u1aGk1U+1jHhMD1ZPYcPkibum64mrxs9FsZ1bWAG9v7QHDg==" },
    { kind: "deb", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.deb", sizeMb: 106, sha256: "024dce25453a5c44fa62f148c93be3b85d48214e8000e43a5f912e7f34abc069" },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};

// The Windows preview, under its own tag (vX-windows.N) like Linux. Null
// until the first Windows release: then the download page has no Windows
// section and no win-*.json feed is written. When it is filled, each file
// needs its size, SHA-256 and the signature scripts/sign-update.mjs (windows)
// prints; the app checks that signature before it runs an update. Shape:
// { tag: "v0.5.1-windows.1", version: "0.5.1", date: "2026-12-01",
//   files: [{ arch: "x64" | "arm64", asset: "Vunemi-Setup-0.5.1-x64.exe", sizeMb, sha256, signature }],
//   url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
//   get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; } }
export const windowsRelease = {
  tag: "v0.5.1-windows.1",
  version: "0.5.1",
  date: "2026-11-26",
  files: [
    { arch: "x64", asset: "Vunemi-Setup-0.5.1-x64.exe", sizeMb: 117, sha256: "cb283cd4007b55c172830ed3eb285df32355d4348d7cca69bc17358b1ebd27c1", signature: "41EwdliJ+gqopGpfjrrkbuPDKdK6fVNEus/k2x8+H67Hl1D5GaN3AIuntUFxiqcs/9Peml3yqAx2tTsk3do9Cg==" },
    { arch: "arm64", asset: "Vunemi-Setup-0.5.1-arm64.exe", sizeMb: 120, sha256: "17dc78169516b74ac15fb9021fcbe8d67aa21aef5a84f77c48e3ed09af1486a1", signature: "Q+qyACJmSRnvXv6WGGDdu0PXPivOMLIJfL9dtcAYbyZponuxZx7ML/We3aShf+izD3RzGcfUp8ZG0xjpayV/DA==" },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};
