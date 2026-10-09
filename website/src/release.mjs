// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.1.16",
  date: "2026-10-09",
  asset: "Vunemi-0.1.16-arm64.dmg",
  sizeMb: 133,
  sha256: "ea2f20162c102aae9328596bdbcadcbc85d610f068e05c8a3a83efe32dd74adc",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.1.16-arm64.zip",
  zipSizeMb: 135,
  zipSha256: "a4202c7449b0b39d59a2c5193fa578948de2aa16a520976f2a356a6d53601905",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";
