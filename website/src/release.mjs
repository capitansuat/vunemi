// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.18",
  date: "2026-10-10",
  asset: "Vunemi-0.1.18-arm64.dmg",
  sizeMb: 141,
  sha256: "54a1b55c12a8720703a0fad237942c257cdb4df50eb43cd1c7745fcc9f68dba3",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.18-arm64.zip",
  zipSizeMb: 142,
  zipSha256: "d3b12b85e685e562f4f5e5ab2eac395169d88f0736b4fada8ec632b8c1a161a5",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
