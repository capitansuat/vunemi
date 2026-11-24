# Checks a built engine before it may ship: only Windows' own DLLs, nothing of
# the builder's user folder inside, and it starts (an x64 build runs under
# Windows on ARM's emulator). Run inside Visual Studio's shell (dumpbin).
param(
  [Parameter(Mandatory)][string]$Path,
  [string[]]$Smoke = @("--version")
)
$ErrorActionPreference = "Continue"
if (-not (Test-Path $Path)) { Write-Host "! yok: $Path"; exit 1 }

$allowed = '^(kernel32|advapi32|ws2_32|user32|shell32|ole32|oleaut32|bcrypt|ntdll|api-ms-win-[a-z0-9-]+)\.dll$'
$deps = & dumpbin /nologo /dependents $Path | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.dll$' }
$bad = $deps | Where-Object { $_.ToLowerInvariant() -notmatch $allowed }
if ($bad) { Write-Host "! Windows dışı DLL: $($bad -join ', ')"; exit 1 }

# The builder's folder, as text or as UTF-16 (how Windows strings are kept).
$bytes = [IO.File]::ReadAllBytes($Path)
$text = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
$wide = [Text.Encoding]::Unicode.GetString($bytes)
foreach ($haystack in @($text, $wide)) {
  if ($haystack.IndexOf('C:\Users\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Write-Host "! derleme yolu (kullanıcı klasörü) içinde: $Path"; exit 1
  }
}

# All of the output is read: cutting the pipe short would stop the program and look like a failure.
$out = @(& $Path @Smoke 2>&1)
if ($LASTEXITCODE) { Write-Host "! çalışmadı ($LASTEXITCODE): $Path"; $out | Select-Object -First 3; exit 1 }
Write-Host "› denetim tamam: $(Split-Path -Leaf $Path) — $($deps -join ', ')"
exit 0
