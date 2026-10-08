// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.15",
  date: "2026-10-08",
  asset: "Vunemi-0.1.15-arm64.dmg",
  sizeMb: 133,
  sha256: "59392ba9a64457e08948e7ebc7f64cbfbabca1b386a7e10c2b02d9c18aef659e",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.15-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "9c48eb481e00f438b7b2b56dbd7ec46b4299d4498cf7284e0f94ea1133c94db0",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
