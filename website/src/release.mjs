// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.19",
  date: "2026-10-10",
  asset: "Vunemi-0.1.19-arm64.dmg",
  sizeMb: 141,
  sha256: "0e6c400b0aad8e3bd40cc0fa30203a95b53e7697179773b6aebfa34bac8a20b5",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.19-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "3b641ad5616c37df944809bea18fbec159eca762169d59df2af8012b4207d453",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
