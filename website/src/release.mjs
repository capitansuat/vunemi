// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.4.0",
  date: "2026-11-23",
  asset: "Vunemi-0.4.0-arm64.dmg",
  sizeMb: 232,
  sha256: "d615092bdf910230881ca420e900bd47da61fea5caffb01b09c715c082f6451a",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.4.0-arm64.zip",
  zipSizeMb: 242,
  zipSha256: "651f28ed45644f51c8b84b7e13cbb4f1a230fe56cbc8318fbc01216d512dcbbd",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";

// The Linux preview, a pre-release of its own. The Mac fields above and the
// update feed don't depend on it; a Linux build doesn't update itself.
export const linuxRelease = {
  tag: "v0.2.6-linux.1",
  version: "0.2.6",
  files: [
    { kind: "deb", asset: "Vunemi-0.2.6-linux-amd64.deb", sizeMb: 105, sha256: "e804939f8de91c0fc5d1fa8262fb80ac094bb8fafcb9a8b8f494ae0273b13a71" },
    { kind: "appImage", asset: "Vunemi-0.2.6-linux-x86_64.AppImage", sizeMb: 135, sha256: "b6b2412b3bfbde15f52f89f200a71d2da14e63f5139d979b691be2cfefe4d761" },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};

// The Windows preview, under its own tag (vX-windows.N) like Linux. Null
// until the first Windows release: then the download page has no Windows
// section and no win-*.json feed is written. When it is filled, each file
// needs its size, SHA-256 and the signature scripts/sign-windows-update.mjs
// prints; the app checks that signature before it runs an update. Shape:
// { tag: "v0.5.1-windows.1", version: "0.5.1", date: "2026-12-01",
//   files: [{ arch: "x64" | "arm64", asset: "Vunemi-Setup-0.5.1-x64.exe", sizeMb, sha256, signature }],
//   url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
//   get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; } }
export const windowsRelease = null;
