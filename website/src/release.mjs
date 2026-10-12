// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.20",
  date: "2026-10-12",
  asset: "Vunemi-0.1.20-arm64.dmg",
  sizeMb: 141,
  sha256: "ddf88f336ccae7abb4debcf83433d8cc05c60ec837e92c08b1b60eea3a8239ba",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.20-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "33af1a688d665e168bde125e4925f76a0ce814b44aaf38ce7e3b11485bf32731",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
