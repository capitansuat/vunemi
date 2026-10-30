// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.4",
  date: "2026-10-30",
  asset: "Vunemi-0.2.4-arm64.dmg",
  sizeMb: 142,
  sha256: "ccdc5774a48d7f32d55255840d9c115c16f0eca80e7db5d27476c71c053b74fd",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.4-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "198ab3378a9658e47b9564aa3b0e1ee1d0d264e72338a34ab0b9b3f483e93778",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
