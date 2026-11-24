# Builds whisper.cpp's server for Windows — what Vunemi turns speech into text
# with — from the release build-whisper-linux.sh pins, for x64 or arm64, on
# the ARM64 machine. The same rules as build-engine.ps1, and no SDL, curl or
# ffmpeg: it reads the WAV Vunemi sends it over plain HTTP on 127.0.0.1.
#
# Licence: whisper.cpp is MIT (its LICENSE ships next to the binary).
param([Parameter(Mandatory)][ValidateSet("x64", "arm64")][string]$Arch)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$pins = Get-Content -Raw (Join-Path $Root "build-whisper-linux.sh")
$tag = if ($env:VUNEMI_WHISPER_TAG) { $env:VUNEMI_WHISPER_TAG } else { [regex]::Match($pins, 'tag="\$\{VUNEMI_WHISPER_TAG:-([^}]+)\}"').Groups[1].Value }
$commit = if ($env:VUNEMI_WHISPER_COMMIT) { $env:VUNEMI_WHISPER_COMMIT } else { [regex]::Match($pins, 'commit="\$\{VUNEMI_WHISPER_COMMIT:-([0-9a-f]+)\}"').Groups[1].Value }
if (-not $tag -or -not $commit) { throw "build-whisper-linux.sh could not be read" }

$src = Join-Path $BuildDir "whisper-src\$tag"
$cache = Join-Path $BuildDir "whisper-cache\$tag-win-$Arch"
Enter-BuildShell $Arch

$ready = Join-Path $cache "whisper-server.exe"
if ((Test-Path $ready) -and ((Get-Content (Join-Path $cache "ARCH") -ErrorAction SilentlyContinue) -eq $Arch)) {
  & (Join-Path $PSScriptRoot "check-binary.ps1") -Path $ready -Smoke @("--help") | Out-Null
  if (-not $LASTEXITCODE) { Write-Host "› ses motoru hazır ($tag, $Arch)"; exit 0 }
}

Get-PinnedSource "https://github.com/ggml-org/whisper.cpp.git" $tag $commit $src
Write-Host "› ses motoru derleniyor ($tag, $Arch)"
$bin = Invoke-EngineBuild $src $Arch "whisper-server" @(
  "-DWHISPER_SDL2=OFF", "-DWHISPER_CURL=OFF", "-DWHISPER_FFMPEG=OFF",
  "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_SERVER=ON"
)
Save-ToCache $bin (Join-Path $src "LICENSE") $cache $Arch @("--help")
Write-Host "› ses motoru hazır → $cache"
