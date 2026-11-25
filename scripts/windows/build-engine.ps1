# Builds llama.cpp's server for Windows — the engine Vunemi runs downloaded
# models with — from the release scripts/engine-version.sh pins, for x64 or
# arm64, on the ARM64 machine (x64 is cross-compiled with the same clang).
#
#  * From source, pinned to a commit, like the macOS and Linux builds.
#  * CPU only in release 1; GGML_NATIVE off so it runs on any CPU of the
#    architecture (arm64: armv8.2 + dotprod + fp16; x64: AVX2).
#  * Static: no OpenMP, the MSVC runtime linked in, only Windows' own DLLs.
#  * No OpenSSL or curl, no downloads of its own, no subprocesses: plain HTTP
#    on 127.0.0.1 and the one model file Vunemi downloaded and checked.
#
# Licence: llama.cpp is MIT (its LICENSE ships next to the binary).
param([Parameter(Mandatory)][ValidateSet("x64", "arm64")][string]$Arch)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$pins = Get-Content -Raw (Join-Path $Root "engine-version.sh")
$tag = if ($env:VUNEMI_ENGINE_TAG) { $env:VUNEMI_ENGINE_TAG } else { [regex]::Match($pins, 'engine_tag="\$\{VUNEMI_ENGINE_TAG:-([^}]+)\}"').Groups[1].Value }
$commit = if ($env:VUNEMI_ENGINE_COMMIT) { $env:VUNEMI_ENGINE_COMMIT } else { [regex]::Match($pins, 'engine_commit="\$\{VUNEMI_ENGINE_COMMIT:-([0-9a-f]+)\}"').Groups[1].Value }
if (-not $tag -or -not $commit) { throw "engine-version.sh could not be read" }

$src = Join-Path $BuildDir "engine-src\$tag"
$cache = Join-Path $BuildDir "engine-cache\$tag-win-$Arch"
Enter-BuildShell $Arch

$ready = Join-Path $cache "llama-server.exe"
if ((Test-Path $ready) -and ((Get-Content (Join-Path $cache "ARCH") -ErrorAction SilentlyContinue) -eq $Arch)) {
  & (Join-Path $PSScriptRoot "check-binary.ps1") -Path $ready | Out-Null
  if (-not $LASTEXITCODE) { Write-Host "› motor hazır ($tag, $Arch)"; exit 0 }
}

Get-PinnedSource "https://github.com/ggml-org/llama.cpp.git" $tag $commit $src
Write-Host "› motor derleniyor ($tag, $Arch)"
$bin = Invoke-EngineBuild $src $Arch "llama-server" @(
  "-DLLAMA_OPENSSL=OFF", "-DLLAMA_CURL=OFF", "-DLLAMA_SUBPROCESS=OFF", "-DLLAMA_BUILD_UI=OFF", "-DLLAMA_USE_PREBUILT_UI=OFF",
  "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_SERVER=ON"
)
Save-ToCache $bin (Join-Path $src "LICENSE") $cache $Arch @("--version")
Write-Host "› motor hazır → $cache"
