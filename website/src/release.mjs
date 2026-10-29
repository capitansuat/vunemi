// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.1",
  date: "2026-10-29",
  asset: "Vunemi-0.2.1-arm64.dmg",
  sizeMb: 142,
  sha256: "af2ea2d370af31e6f21da82515afbb47d040b2c70bf6f43d4df4a96cdc376a49",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.1-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "78caabbb4b6a65365186fcf979005efaeecc7de923c716b775ae4ac85a6d6ac8",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
