// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.5",
  date: "2026-10-31",
  asset: "Vunemi-0.2.5-arm64.dmg",
  sizeMb: 142,
  sha256: "f1efa01248a6d3a7f1a9d8ad75289d7ec9066cf71de621d8d15aae9a08aa2cba",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.5-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "fbd36575ff6b1529263c0dc9056f01c348921bbee9d20697551d5f5d9b77f42f",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
