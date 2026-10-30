// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.3",
  date: "2026-10-30",
  asset: "Vunemi-0.2.3-arm64.dmg",
  sizeMb: 142,
  sha256: "ba0c2054ebe2d27fcbc762ee9e5d75dd87240ad7efc992d7e3cdcf0ff62f1786",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.3-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "5931a09815d241ba23ab96961090008365d62bb50c9f4fa5c1ae73fd4ef5706c",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
