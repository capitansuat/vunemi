// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.10",
  date: "2026-10-05",
  asset: "Vunemi-0.1.10-arm64.dmg",
  sizeMb: 133,
  sha256: "7be9e1d2590eb855b07dc33b0cffc6773f7c33e202746495e049108eec7b290b",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.10-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "85d0e8052c18d11f370c30251941be57b09612eceb4a4395feea40a8cbe23cfd",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
