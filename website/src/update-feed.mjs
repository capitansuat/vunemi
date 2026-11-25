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
