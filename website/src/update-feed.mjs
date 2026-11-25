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
