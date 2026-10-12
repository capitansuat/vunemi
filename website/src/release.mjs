// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.21",
  date: "2026-10-12",
  asset: "Vunemi-0.1.21-arm64.dmg",
  sizeMb: 141,
  sha256: "bfddc4a056f82dba7c6b570ba6180fb90855e6fb69a2b4489db3df76f8afd76a",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.21-arm64.zip",
  zipSizeMb: 143,
  zipSha256: "31022ba3e333fc143a4fc6c1f06fe7bd03a044004aa445e3a7dc9258fb1da258",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
