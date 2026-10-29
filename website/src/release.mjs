// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.2",
  date: "2026-10-29",
  asset: "Vunemi-0.2.2-arm64.dmg",
  sizeMb: 142,
  sha256: "595b59551d94bb4963713e0a84287a78960a33cec7b2a6a3e4c9f4cec3388cf3",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.2-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "3f6908f3e089cb68bd3c54e45a6db7afa7f7621e47a7e3f6284b8213195284e4",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
