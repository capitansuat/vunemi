// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.11",
  date: "2026-10-05",
  asset: "Vunemi-0.1.11-arm64.dmg",
  sizeMb: 133,
  sha256: "bb11ffac9393da8c060489cce9074553536374d00d4d606a7b2b94148cc7e143",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.11-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "59182db6fc53a4eeac558fffc7e751f96a806f6bacf311a01a921d767e61036f",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
