// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.18",
  date: "2026-10-10",
  asset: "Vunemi-0.1.18-arm64.dmg",
  sizeMb: 141,
  sha256: "bcf4d6e6a6abf2ec9522f5c92923dd5589b94d059a12433a7f6befa6d16d1108",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.18-arm64.zip",
  zipSizeMb: 142,
  zipSha256: "d5e61406bcf4f515df7edadcd6e2e970b178b301cba0bc11e188a335b8567972",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
