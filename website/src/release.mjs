// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.13",
  date: "2026-10-08",
  asset: "Vunemi-0.1.13-arm64.dmg",
  sizeMb: 133,
  sha256: "c37fa94542b66c83530eeaccdcab44a2ec37aa9ef9380fd8c41d7991c5cd1042",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.13-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "5bd65b702b9f899e03e078a743fe117a528bf040253b126043ffe61c12239605",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
