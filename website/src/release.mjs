// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.6",
  date: "2026-09-29",
  asset: "Vunemi-0.1.6-arm64.dmg",
  sizeMb: 133,
  sha256: "e5c58d276d0678c9e90c5cbe0eeff0b3ceb58f0e5f290825f750a9c5719df38d",
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
