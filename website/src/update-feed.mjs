// What an installed Vunemi reads to learn of a new version: Squirrel.Mac's
// static JSON format, plus the download size and the site's "What's new"
// in every language. Generated from release.mjs; never edited by hand.
export function updateFeed(release, copy, languages) {
  if (!release.zip) return null;
  return {
    currentRelease: release.version,
    releases: [{
      version: release.version,
      updateTo: { version: release.version, name: `Vunemi ${release.version}`, pub_date: `${release.date}T00:00:00Z`, notes: "", url: release.zipUrl },
    }],
    sizeMb: release.zipSizeMb,
    notes: Object.fromEntries(languages.map((code) => [code, copy[code].downloadPage.highlights])),
  };
}

// The Windows feeds (vunemi.com/update/win-<arch>.json): the same form, plus
// the installer's SHA-256 and the maintainer's signature over version,
// architecture and SHA-256, which the app checks before it downloads
// (apps/desktop/src/main/updates/feed.ts). Notes are Windows' own: the Mac's
// highlights would describe another app.
export function windowsFeed(windowsRelease, arch, windowsCopy, languages) {
  const file = windowsRelease?.files.find((f) => f.arch === arch);
  if (!file) return null;
  const { version, date } = windowsRelease;
  return {
    currentRelease: version,
    releases: [{
      version,
      updateTo: { version, name: `Vunemi ${version}`, pub_date: `${date}T00:00:00Z`, notes: "", url: windowsRelease.url(file.asset), sha256: file.sha256, signature: file.signature },
    }],
    sizeMb: file.sizeMb,
    notes: Object.fromEntries(languages.map((code) => [code, windowsCopy[code].updateNotes])),
  };
}

// The Windows preview: the tag and file names follow its version, each
// architecture once, each file with a size, its SHA-256 and the signature
// the app checks (an Ed25519 signature is 64 bytes: 88 base64 characters).
export function checkWindowsRelease(win) {
  if (!/^\d+\.\d+\.\d+$/.test(win.version)) throw new Error(`Windows version ${win.version} is not x.y.z`);
  if (!new RegExp(`^v${win.version.replace(/\./g, "\\.")}-windows\\.\\d+$`).test(win.tag)) throw new Error(`Windows tag ${win.tag} does not match ${win.version}`);
  if (win.files.length === 0) throw new Error("Windows release without files");
  const seen = new Set();
  for (const file of win.files) {
    if (file.arch !== "x64" && file.arch !== "arm64") throw new Error(`Windows file for unknown architecture ${file.arch}`);
    if (seen.has(file.arch)) throw new Error(`Two Windows files for ${file.arch}`);
    seen.add(file.arch);
    if (file.asset !== `Vunemi-Setup-${win.version}-${file.arch}.exe`) throw new Error(`Windows file ${file.asset} does not match ${win.version}`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !(file.sizeMb > 0)) throw new Error(`Windows file ${file.asset}: size or SHA-256 missing`);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(file.signature ?? "")) throw new Error(`Windows file ${file.asset}: signature missing`);
  }
}

/** electron-builder's names for a Linux file of this kind and architecture. */
const linuxAsset = (version, kind, arch) =>
  kind === "deb" ? `Vunemi-${version}-linux-${arch === "x64" ? "amd64" : "arm64"}.deb` : `Vunemi-${version}-linux-${arch === "x64" ? "x86_64" : "arm64"}.AppImage`;

/**
 * vunemi.com/update/linux-<arch>.json: the signed AppImage of this
 * architecture, in the form the app checks (apps/desktop/src/main/updates/
 * feed.ts, linuxSource). A .deb can't replace itself, so it never has a feed
 * entry; an AppImage without a signature (the 0.2.6 preview) has none either.
 */
export function linuxFeed(linuxRelease, arch, linuxCopy, languages) {
  const file = linuxRelease?.files.find((f) => f.kind === "appImage" && f.arch === arch && f.signature);
  if (!file) return null;
  const { version, date } = linuxRelease;
  return {
    currentRelease: version,
    releases: [{
      version,
      updateTo: { version, name: `Vunemi ${version}`, pub_date: `${date}T00:00:00Z`, notes: "", url: linuxRelease.url(file.asset), sha256: file.sha256, signature: file.signature },
    }],
    sizeMb: file.sizeMb,
    notes: Object.fromEntries(languages.map((code) => [code, linuxCopy[code].updateNotes])),
  };
}

/** The Linux record, checked before it is offered: names, tag, one AppImage and one .deb per architecture, signatures on AppImages only. */
export function checkLinuxRelease(lin) {
  if (!/^\d+\.\d+\.\d+$/.test(lin.version)) throw new Error(`Linux version ${lin.version} is not x.y.z`);
  if (!new RegExp(`^v${lin.version.replace(/\./g, "\\.")}-linux\\.\\d+$`).test(lin.tag)) throw new Error(`Linux tag ${lin.tag} does not match ${lin.version}`);
  if (lin.files.length === 0) throw new Error("Linux release without files");
  const seen = new Set();
  for (const file of lin.files) {
    if (file.kind !== "deb" && file.kind !== "appImage") throw new Error(`Linux file of unknown kind ${file.kind}`);
    if (file.arch !== "x64" && file.arch !== "arm64") throw new Error(`Linux file for unknown architecture ${file.arch}`);
    const key = `${file.kind}:${file.arch}`;
    if (seen.has(key)) throw new Error(`Two Linux ${file.kind} files for ${file.arch}`);
    seen.add(key);
    if (file.asset !== linuxAsset(lin.version, file.kind, file.arch)) throw new Error(`Linux file ${file.asset} does not match ${lin.version} (${file.kind}, ${file.arch})`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Linux file ${file.asset}: SHA-256 missing`);
    if (!(file.sizeMb > 0)) throw new Error(`Linux file ${file.asset}: size missing`);
    if (file.signature !== undefined) {
      if (file.kind !== "appImage") throw new Error(`Linux file ${file.asset}: only AppImages carry a signature`);
      if (!/^[A-Za-z0-9+/]{86}==$/.test(file.signature)) throw new Error(`Linux file ${file.asset}: signature malformed`);
    }
  }
  for (const arch of ["x64", "arm64"]) {
    const kinds = ["deb", "appImage"].filter((kind) => seen.has(`${kind}:${arch}`));
    if (kinds.length === 1) throw new Error(`Linux ${arch} needs an AppImage and a .deb, not only a ${kinds[0]}`);
  }
}
