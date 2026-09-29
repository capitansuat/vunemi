// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.8",
  date: "2026-09-29",
  asset: "Vunemi-0.1.8-arm64.dmg",
  sizeMb: 133,
  sha256: "739fbcd6b638dffd1791064198546fd3a0033366287bae7887c41ee467071243",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.8-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "fd77c476bf6aef1c16dbd8caf23c8dde2235f175e5b48f32cb58558a2923bf47",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
