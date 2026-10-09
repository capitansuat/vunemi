// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.17",
  date: "2026-10-09",
  asset: "Vunemi-0.1.17-arm64.dmg",
  sizeMb: 133,
  sha256: "1d88210042f95b14fda0c395a256d86a936c95eb229d82fa8195c4df9ee63f39",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.17-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "7bf9191b3fae4802a9d1a3bf29496412002c23a61247a4888d0af3ff4a35e4fd",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
