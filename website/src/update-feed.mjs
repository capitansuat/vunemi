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
