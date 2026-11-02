// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.6",
  date: "2026-11-02",
  asset: "Vunemi-0.2.6-arm64.dmg",
  sizeMb: 142,
  sha256: "9b7f68fb46a7b45bdef45313a842c7943513fe9ddc500eb8d578e6af392d16f8",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.6-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "e12042e91fd49f27e5c894a77a3b918310aab0c0323b9da075780d6a36150eed",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
