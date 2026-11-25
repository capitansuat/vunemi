# Shared by build-engine.ps1 and build-whisper.ps1: the pinned source, the
# Visual Studio shell for an architecture, and the one CMake build both use.
# Dot-sourced; nothing here runs on its own.

$script:Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:BuildDir = if ($env:VUNEMI_BUILD_DIR) { $env:VUNEMI_BUILD_DIR } else { Join-Path $env:USERPROFILE ".vunemi-build" }

# The pinned source: cloned once at the tag, and refused unless it is the commit.
function Get-PinnedSource([string]$Url, [string]$Tag, [string]$Commit, [string]$Dir) {
  if (-not (Test-Path (Join-Path $Dir ".git"))) {
    Write-Host "› $Tag indiriliyor"
    New-Item -ItemType Directory -Force (Split-Path -Parent $Dir) | Out-Null
    git clone --quiet --depth 1 --branch $Tag $Url $Dir
    if ($LASTEXITCODE) { throw "clone failed: $Url $Tag" }
  }
  $actual = git -C $Dir rev-parse HEAD
  if ($actual -ne $Commit) { throw "$Tag is not the expected commit: $actual (expected $Commit)" }
}

# Visual Studio's build environment, on this ARM64 machine, for the target architecture.
function Enter-BuildShell([string]$Arch) {
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -products * -latest -property installationPath
  if (-not $vs) { throw "Visual Studio Build Tools are not installed" }
  $vsArch = if ($Arch -eq "x64") { "amd64" } else { "arm64" }
  & "$vs\Common7\Tools\Launch-VsDevShell.ps1" -Arch $vsArch -HostArch arm64 -SkipAutomaticLocation | Out-Null
}

# Configures and builds one target, with the flags every shipped engine uses.
function Invoke-EngineBuild([string]$Src, [string]$Arch, [string]$Target, [string[]]$Extra) {
  $toolchain = Join-Path $PSScriptRoot "$Arch-baseline.cmake"
  $build = Join-Path $Src "build-win-$Arch"
  if (Test-Path $build) { Remove-Item -Recurse -Force $build }
  # The source path is mapped away so the builder's folder doesn't ship in the binary.
  $map = "-ffile-prefix-map=$Src=."
  $common = @(
    "-S", $Src, "-B", $build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DCMAKE_C_FLAGS=$map", "-DCMAKE_CXX_FLAGS=$map",
    # The static MSVC runtime. whisper.cpp asks for CMake 3.5, whose policies
    # ignore CMAKE_MSVC_RUNTIME_LIBRARY, so the 3.15 policy is set for it.
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
    "-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF"
  )
  if ($Arch -eq "arm64") { $common += "-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16" }
  # Only the function's result goes to the pipeline; the tools' output is shown.
  cmake @common @Extra 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) { throw "cmake configure failed ($Target, $Arch)" }
  cmake --build $build --config Release --target $Target -j 4 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) { throw "build failed ($Target, $Arch)" }
  return (Join-Path $build "bin\$Target.exe")
}

# Puts a checked binary and its licence into the cache, named by architecture.
function Save-ToCache([string]$Binary, [string]$License, [string]$Cache, [string]$Arch, [string[]]$Smoke) {
  & (Join-Path $PSScriptRoot "check-binary.ps1") -Path $Binary -Smoke $Smoke | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) { throw "check failed: $Binary" }
  New-Item -ItemType Directory -Force $Cache | Out-Null
  Copy-Item $Binary (Join-Path $Cache (Split-Path -Leaf $Binary)) -Force
  Copy-Item $License (Join-Path $Cache "LICENSE") -Force
  Set-Content (Join-Path $Cache "ARCH") $Arch
}
