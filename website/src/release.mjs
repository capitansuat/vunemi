// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.7",
  date: "2026-09-29",
  asset: "Vunemi-0.1.7-arm64.dmg",
  sizeMb: 133,
  sha256: "6fcd3e16e6858dc6511f797d25eb3587f31ad90c98476481ea4937a27c7d7cbe",
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
