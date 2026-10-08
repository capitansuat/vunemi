// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.14",
  date: "2026-10-08",
  asset: "Vunemi-0.1.14-arm64.dmg",
  sizeMb: 133,
  sha256: "42ecfcb95e4cf18b9538d00206e70bedb93b9177913a90192cc8d0658919bef7",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.14-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "cfd67a622e4e2f4157163de6f49f9285b670afc732bd8b13bbcd7e97e6e5100a",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
