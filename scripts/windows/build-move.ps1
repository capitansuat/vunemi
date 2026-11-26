# Builds vunemi-move, files_move's native step (native/move), for Windows,
# x64 or arm64, on the ARM64 machine, with the Build Tools' clang and the same
# toolchain files as the engines. Nothing is downloaded.
param([Parameter(Mandatory)][ValidateSet("x64", "arm64")][string]$Arch)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$version = "1"  # MOVE_VERSION in apps/desktop/src/main/native-move.ts
$src = Join-Path (Split-Path -Parent $Root) "native\move"
$cache = Join-Path $BuildDir "move-cache\$version-win-$Arch"
$build = Join-Path $BuildDir "move-build\win-$Arch"
$inputs = @($MyInvocation.MyCommand.Path) + (Get-ChildItem $src -File -Include *.c, *.h, CMakeLists.txt -Recurse | Sort-Object Name | ForEach-Object FullName)
$key = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes((($inputs | ForEach-Object { Get-Content -Raw $_ }) -join "`n"))))).Hash
$ready = Join-Path $cache "vunemi-move.exe"
if ((Test-Path $ready) -and ((Get-Content (Join-Path $cache ".built-from") -ErrorAction SilentlyContinue) -eq $key)) { Write-Host "› taşıma programı hazır ($Arch)"; exit 0 }

Enter-BuildShell $Arch
Write-Host "› taşıma programı derleniyor ($Arch)"
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
$map = "-ffile-prefix-map=$src=."
cmake -S $src -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_TOOLCHAIN_FILE=$(Join-Path $PSScriptRoot "$Arch-baseline.cmake")" "-DCMAKE_C_FLAGS=$map" `
  -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE) { throw "cmake configure failed (vunemi-move, $Arch)" }
cmake --build $build --config Release 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE) { throw "build failed (vunemi-move, $Arch)" }
$bin = Join-Path $build "vunemi-move.exe"
& (Join-Path $PSScriptRoot "check-binary.ps1") -Path $bin -Smoke @("--version") | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE) { throw "check failed: $bin" }
New-Item -ItemType Directory -Force $cache | Out-Null
Copy-Item $bin $ready -Force
Set-Content (Join-Path $cache ".built-from") $key
Write-Host "› taşıma programı hazır → $cache"
