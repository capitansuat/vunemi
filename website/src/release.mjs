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
  tag: "v0.5.0-linux.1",
  version: "0.5.0",
  date: "2026-11-26",
  files: [
    { kind: "appImage", arch: "x64", asset: "Vunemi-0.5.0-linux-x86_64.AppImage", sizeMb: 127, sha256: "6832d3e6b50c89d3c98d7ce19ac3532e3737f49a912bcfe10b03384d0c64a84e", signature: "ZWK1HEBDPWcStrk+rj7AYC8ANWKfxvuBOvETnI8EONVt4VGcyv23+kkyhz5e6T9Nd5g7WPTrb9f8+GZjbvGHCg==" },
    { kind: "deb", arch: "x64", asset: "Vunemi-0.5.0-linux-amd64.deb", sizeMb: 106, sha256: "c2fe59aff14d0d23e630946ba5f7b082e5130118c308e300512cb1a6556593f0" },
    { kind: "appImage", arch: "arm64", asset: "Vunemi-0.5.0-linux-arm64.AppImage", sizeMb: 127, sha256: "bdffaa857fd32d4a57e07cc7a72453a9385f0c04154122b8de79e32c578bd662", signature: "A8dRYQZpsmOPANQCLFWqDWrKJ3PRyCCXhKG32PnmayJ6Bd70InnoqSewFzaXaQ3/9Ex87RDOhK94Ut9DgEyxCQ==" },
    { kind: "deb", arch: "arm64", asset: "Vunemi-0.5.0-linux-arm64.deb", sizeMb: 101, sha256: "149a6b75e665f19326653d8be3d1db67d1232aa2bb7377061fbc8733322b736c" },
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
