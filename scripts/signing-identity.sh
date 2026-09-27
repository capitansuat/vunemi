#!/usr/bin/env bash
# Creates the signing identity Vunemi is packaged with, once, in your login
# keychain. Run it yourself: it adds a private key to your keychain, and that
# is your decision to make.
#
# Why it exists. Without it the app is signed ad hoc, and an ad-hoc app is
# identified by the hash of its code — so every build is, to macOS, a
# different app. The calendar permission is granted to the old one, the
# keychain refuses the new one the key to the vault, and the user loses both
# on every update.
#
# Signed with this identity, the app's designated requirement becomes
#   identifier "com.vunemi.app" and certificate leaf = H"<this certificate>"
# which stays the same from build to build, and which only code signed with
# this private key can meet. That is stronger than ad hoc, not weaker.
#
# The certificate is self-signed and stays untrusted; codesign does not need
# it trusted, and nothing here changes what your Mac trusts. The private key
# is generated in a temporary folder, imported, and the folder is deleted.
set -euo pipefail

name="Vunemi Signing"

if security find-identity -p codesigning | grep -q "\"$name\""; then
  echo "› \"$name\" zaten var; yapılacak bir şey yok."
  security find-identity -p codesigning | grep "\"$name\""
  exit 0
fi

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# macOS's own LibreSSL, so this does not depend on what Homebrew installed —
# and so the .p12 uses algorithms `security import` can read.
openssl=/usr/bin/openssl
pass="$("$openssl" rand -hex 24)"

echo "› anahtar ve sertifika oluşturuluyor (10 yıl geçerli)"
"$openssl" req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -subj "/CN=$name" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" 2>/dev/null
"$openssl" pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout "pass:$pass"

echo "› giriş anahtar zincirine ekleniyor (yalnızca codesign kullanabilir)"
security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$pass" -T /usr/bin/codesign

echo "› hazır:"
security find-identity -p codesigning | grep "\"$name\""
echo
echo "Bundan sonra \`pnpm package\` bu kimlikle imzalar. İlk imzalamada macOS"
echo "\"codesign anahtarı kullanmak istiyor\" diye sorarsa \"Her Zaman İzin Ver\"i seç."
