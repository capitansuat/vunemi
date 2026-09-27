#!/usr/bin/env bash
# Builds Vunemi as a real .app, signed, with the permissions macOS insists on.
#
# Three things here are not optional, and each was found the hard way:
#
#  * The app must be packaged. TCC attributes a permission request to the
#    *responsible* process — the one that started the chain — so an app run
#    from a terminal or another program asks on that program's behalf, and
#    calendar access is refused with no dialog at all.
#  * It must be signed with the entitlements. Under the hardened runtime
#    kTCCServiceCalendar requires com.apple.security.personal-information.
#    calendars; without it the refusal is silent.
#  * It must be built outside iCloud's reach. A synced folder leaves
#    com.apple.fileprovider xattrs on every file and codesign refuses them
#    ("resource fork, Finder information, or similar detritus not allowed").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
entitlements="$here/apps/desktop/build/entitlements.mac.plist"
# The helper's own, narrower list: see the file for why it is kept apart.
helper_entitlements="$here/native/VunemiHelper/VunemiHelper.entitlements"
distribution="${VUNEMI_DISTRIBUTION:-0}"

# A stable identity, when there is one (scripts/signing-identity.sh). Ad hoc
# works, but an ad-hoc app is identified by the hash of its code, so every
# build is a new app to macOS and the calendar permission stays with the
# previous one. (The vault's key does not depend on this: the helper holds
# it.) A self-signed build waits a few seconds at launch (~6 s measured) while
# taskgated checks it; that is all it costs.
find_identity() { security find-identity -p codesigning | grep "\"$1\"" | head -1 | awk '{print $2}' || true; }
identity="${VUNEMI_SIGN_IDENTITY:-$(find_identity "Vunemi Signing")}"
if [ -z "$identity" ]; then
  identity="-"
  echo "! UYARI: kalıcı imza kimliği yok, ad-hoc imzalanıyor."
  echo "!   Her derleme Takvim iznini sıfırlar."
  echo "!   Bir kez çalıştır: pnpm signing-identity"
fi

# A build for other people. Two kinds, by the identity that signs it:
#
#  * Developer ID: timestamped for notarization, and without the library
#    validation exception, which a Team ID makes unnecessary.
#  * Self-signed (no Apple Developer account): the site download. Gatekeeper
#    blocks the first launch until the user chooses "Open Anyway" in System
#    Settings, and the install page walks them through it. The signature is
#    still worth having: every update from the same identity is the same app
#    to macOS, so permissions and the Vault's keychain item carry over. It
#    keeps the local entitlements (no Team ID means dyld needs the library
#    exception) and signs offline, since only notarization needs a timestamp.
#
# Either way it goes to its own folder, next to the local test build rather
# than over it, and ends as a DMG.
developer_id=0
if [ "$distribution" = "1" ]; then
  if [ "$identity" = "-" ]; then
    echo "! Dağıtım derlemesi ad-hoc imzalanmaz: her sürüm macOS'a yeni bir uygulama olurdu." >&2
    echo "!   Önce: pnpm signing-identity" >&2
    exit 1
  fi
  if security find-identity -p codesigning | grep -F "$identity" | grep -q '"Developer ID Application:'; then
    developer_id=1
  fi
  out_app="$out/dist"
else
  out_app="$out"
fi
app="$out_app/mac-arm64/Vunemi.app"
if [ "$developer_id" = "1" ]; then
  timestamp=(--timestamp)
  dist_entitlements="$(mktemp -t vunemi-entitlements).plist"
  cp "$entitlements" "$dist_entitlements"
  /usr/libexec/PlistBuddy -c "Delete :com.apple.security.cs.disable-library-validation" "$dist_entitlements"
  entitlements="$dist_entitlements"
else
  # Offline: Apple's timestamp server is not asked.
  timestamp=(--timestamp=none)
fi

# The helper, signed, kept per version of its source. The keychain knows the
# helper by the hash of its signed code, so a new hash means a new keychain
# prompt. Its Swift changing is a real reason for one; Xcode or the SDK
# changing is not — yet the same source then compiles to a different binary
# (measured 23 Sep: 276616 → 275816 bytes after the Xcode licence). So the
# signed binary is kept under a hash of what it is made from, and reused
# for as long as that stays the same, whatever the toolchain did.
helper_src="$here/native/VunemiHelper"
helper_key="$(
  # paths-mapped: copies built before build paths were stripped name the user folder.
  { cat "$helper_src/Package.swift" "$helper_src"/Sources/VunemiHelper/*; cat "$helper_entitlements"; echo "$identity" "$developer_id" paths-mapped; } |
    shasum -a 256 | cut -c1-16
)"
helper_cache="$out/helper-cache/$helper_key/VunemiHelper"
helper_build="$helper_src/.build/release/VunemiHelper"

if [ -x "$helper_cache" ] && [ "$identity" != "-" ]; then
  echo "› yardımcı değişmedi ($helper_key): önbellekteki imzalı kopya kullanılıyor"
  # electron-builder copies from the build folder; give it the same binary.
  mkdir -p "$(dirname "$helper_build")"
  cp -p "$helper_cache" "$helper_build"
else
  echo "› yardımcı derleniyor ($helper_key)"
  # The builder's folders stay out of the binary: mapped in the compiler's
  # strings, and the debug symbol table (which lists object files by full
  # path) stripped.
  (cd "$helper_src" && swift build -c release -Xswiftc -file-prefix-map -Xswiftc "$helper_src=." -Xswiftc -debug-prefix-map -Xswiftc "$helper_src=.")
  strip -S "$helper_build"
  if grep -q -a -F "$HOME/" "$helper_build"; then
    echo "! yardımcı derleme yolunu (kullanıcı klasörü) içeriyor"
    exit 1
  fi
fi

echo "› uygulama paketleniyor → $out"
pnpm --filter @vunemi/desktop exec electron-vite build
# A local test build may be opened with --remote-debugging-port (live tests
# drive it over CDP) and shows a warning while it is. A build for other
# people (VUNEMI_DISTRIBUTION=1) refuses to start that way.
test_build=()
if [ "$distribution" != "1" ]; then
  test_build=(--config.extraMetadata.vunemiLocalTestBuild=true)
else
  echo "› dağıtım derlemesi: uzaktan hata ayıklama ile açılmaz"
fi
pnpm --filter @vunemi/desktop exec electron-builder --dir --publish never --config.directories.output="$out_app" ${test_build[@]+"${test_build[@]}"}

echo "› motor"
bash "$here/scripts/build-engine.sh"
engine_cache="$out/engine-cache/v0.5.0"
cp -p "$engine_cache/llama-server" "$app/Contents/Resources/llama-server"
mkdir -p "$app/Contents/Resources/licenses"
cp -p "$engine_cache/LICENSE" "$app/Contents/Resources/licenses/llama.cpp-LICENSE"

echo "› ses motoru"
bash "$here/scripts/build-whisper.sh"
whisper_cache="$out/whisper-cache/v1.9.4"
cp -p "$whisper_cache/whisper-server" "$app/Contents/Resources/whisper-server"
cp -p "$whisper_cache/LICENSE" "$app/Contents/Resources/licenses/whisper.cpp-LICENSE"

echo "› imzalanıyor (önce yardımcı ve motor, sonra uygulama) — kimlik: $identity"
# Hardened runtime and no entitlements: the engine needs none — it reads one
# file and listens on 127.0.0.1.
codesign --force --options runtime "${timestamp[@]}" --identifier com.vunemi.engine --sign "$identity" "$app/Contents/Resources/llama-server"
# The same for the speech engine: it reads one model file and the WAV it is
# sent on 127.0.0.1, and needs no entitlement for either.
codesign --force --options runtime "${timestamp[@]}" --identifier com.vunemi.whisper --sign "$identity" "$app/Contents/Resources/whisper-server"
if [ -x "$helper_cache" ] && [ "$identity" != "-" ]; then
  # Already signed, and it must stay byte for byte what the keychain knows.
  cp -p "$helper_cache" "$app/Contents/Resources/VunemiHelper"
else
  codesign --force --options runtime "${timestamp[@]}" --entitlements "$helper_entitlements" \
    --identifier com.vunemi.helper --sign "$identity" "$app/Contents/Resources/VunemiHelper"
  # Ad hoc has no stable identity to keep; only a real one is worth caching.
  if [ "$identity" != "-" ]; then
    mkdir -p "$(dirname "$helper_cache")"
    cp -p "$app/Contents/Resources/VunemiHelper" "$helper_cache"
  fi
fi
codesign -dvvv "$app/Contents/Resources/VunemiHelper" 2>&1 | grep '^CDHash=' | sed 's/^/› yardımcı /'
codesign --force --deep --options runtime "${timestamp[@]}" --entitlements "$entitlements" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"
codesign -d -r- "$app" 2>&1 | grep designated

echo "› hazır: $app"
if [ "$distribution" = "1" ]; then
  bash "$here/scripts/make-dmg.sh" "$app" "$identity" "$out_app"
else
  echo "  Finder'dan ya da: open \"$app\""
fi
