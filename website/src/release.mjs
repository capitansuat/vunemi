// The release the site offers. Update every field together for a new version,
// after checking the asset on GitHub (name, size, SHA-256, signature).
export const release = {
  version: "0.2.7",
  date: "2026-11-15",
  asset: "Vunemi-0.2.7-arm64.dmg",
  sizeMb: 142,
  sha256: "f75f4d51534f56c811c13d46270a50cad034042df0c851886f09195489893c85",
  // The zip an installed Vunemi updates itself from (0.1.8 on). Absent: no update feed.
  zip: "Vunemi-0.2.7-arm64.zip",
  zipSizeMb: 144,
  zipSha256: "d6d0cba4976844d2fa59908691675cb6a925b4673e6fabeaa9d4c830a09571f6",
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; },
  get url() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/v${this.version}`; },
};

export const repoUrl = "https://github.com/capitansuat/vunemi";

// The Linux preview, a pre-release of its own. The Mac fields above and the
// update feed don't depend on it; a Linux build doesn't update itself.
export const linuxRelease = {
  tag: "v0.2.6-linux.1",
  version: "0.2.6",
  files: [
    { kind: "deb", asset: "Vunemi-0.2.6-linux-amd64.deb", sizeMb: 105, sha256: "e804939f8de91c0fc5d1fa8262fb80ac094bb8fafcb9a8b8f494ae0273b13a71" },
    { kind: "appImage", asset: "Vunemi-0.2.6-linux-x86_64.AppImage", sizeMb: 135, sha256: "b6b2412b3bfbde15f52f89f200a71d2da14e63f5139d979b691be2cfefe4d761" },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};
