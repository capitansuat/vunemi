// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.5.0",
  date: "2026-11-25",
  asset: "Vunemi-0.5.0-arm64.dmg",
  sizeMb: 232,
  sha256: "87e45652fffb97e39e5ebc1ce64a4c76314415efed175ce36b9090f8635f61f7",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.5.0-arm64.zip",
  zipSizeMb: 243,
  zipSha256: "2d700c92581bd92c49ea7d15a5a6cf53ee9f332a17bf92eb6d753a3600fe26ce",
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
  tag: "v0.2.6-linux.1",
  version: "0.2.6",
  date: "2026-11-06",
  files: [
    { kind: "deb", arch: "x64", asset: "Vunemi-0.2.6-linux-amd64.deb", sizeMb: 105, sha256: "e804939f8de91c0fc5d1fa8262fb80ac094bb8fafcb9a8b8f494ae0273b13a71" },
    { kind: "appImage", arch: "x64", asset: "Vunemi-0.2.6-linux-x86_64.AppImage", sizeMb: 135, sha256: "b6b2412b3bfbde15f52f89f200a71d2da14e63f5139d979b691be2cfefe4d761" },
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
  tag: "v0.5.0-windows.1",
  version: "0.5.0",
  date: "2026-11-25",
  files: [
    { arch: "x64", asset: "Vunemi-Setup-0.5.0-x64.exe", sizeMb: 117, sha256: "8969844c2e398b5922c1794050f94a6aca4c3e19f0cf729e5ff42bb7e323a42c", signature: "GcYZU2clEgCpQd4dSUfb/vs3D7pGphAj1x3CCvaIvyTg2rqL8ubSQj91IMvyIV07ysCsRCFYiX878xTXrCU2AA==" },
    { arch: "arm64", asset: "Vunemi-Setup-0.5.0-arm64.exe", sizeMb: 120, sha256: "cd131c230a6ebf5686e185c5728492a31c1a50f1cac67c0825c4204b9c2c69ec", signature: "A8yYxvzuMzyycZUXezQLmRmMkk+iATS5yy3NjXS4hG/q2CkzM6GBZ9wYkkmFW7MJOjXXeQiqqhszwAX5irC9CA==" },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};
