// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.12",
  date: "2026-10-06",
  asset: "Vunemi-0.1.12-arm64.dmg",
  sizeMb: 133,
  sha256: "b2538297e232660f83b638595fe883903d089394efb79f163fe012d644a595cf",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.12-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "5c2dff8c525c0ed416fdf3791f4896501e873204e56b337483019c15dcf9206c",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
