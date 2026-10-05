// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.9",
  date: "2026-10-05",
  asset: "Vunemi-0.1.9-arm64.dmg",
  sizeMb: 133,
  sha256: "88862195b6da7b19306a59ce116db400fe305a9ad9d5050c6cd02a48b716cceb",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.9-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "e30495db11a97bf2af4e82ac31748ffcceea46db66f464796adfdc938782c946",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
