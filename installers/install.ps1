# Mukai CLI installer. Source of truth: the mukai application repository.
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/munashesydney/mukai/releases'
$version = $env:MUKAI_VERSION
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($arch -ne 'X64') { throw 'Windows CLI currently supports x64 only.' }
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MukaiCLI'))
$bin = Join-Path $installRoot 'bin'
$launcher = Join-Path $bin 'mukai.cmd'
if ((Test-Path -LiteralPath $launcher) -and !(Select-String -LiteralPath $launcher -Pattern '^rem Mukai CLI launcher$' -Quiet)) { throw "A different command exists at $launcher." }
$existing = Get-Command mukai -ErrorAction SilentlyContinue
if ($existing -and $existing.Source -ne $launcher) { throw "Another mukai command is active at $($existing.Source). Remove its PATH registration first." }
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$stage = Join-Path $installRoot ('staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  if (!$version) { $version = (Invoke-RestMethod -Uri "$repo/latest/download/cli-manifest.json").version }
  if ($version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version.' }
  $asset = "mukai-cli-$version-win32-x64.zip"
  $base = "$repo/download/v$version"
  $archive = Join-Path $stage $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt").Content
  $lines = @($sums -split "`n" | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [regex]::Escape($asset) + '\s*$') })
  if ($lines.Count -ne 1) { throw 'Release checksum is missing or ambiguous.' }
  $expected = $lines[0].Substring(0, 64)
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $archiveStream = [IO.File]::OpenRead($archive)
  try { $actual = [BitConverter]::ToString($hashAlgorithm.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
  finally { $archiveStream.Dispose(); $hashAlgorithm.Dispose() }
  if ($actual -ne $expected) { throw 'Download checksum does not match.' }
  # Windows' archive utility supports paths beyond legacy PowerShell/.NET's 260-character limit.
  $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
  if (!(Test-Path -LiteralPath $tar)) { throw 'Windows 10 or newer with the built-in tar utility is required.' }
  & $tar -xf $archive -C $stage
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract CLI archive.' }
  $unpacked = Join-Path $stage 'mukai'
  $actualVersion = & (Join-Path $unpacked 'runtime/node.exe') (Join-Path $unpacked 'app/cli.cjs') --version
  if ($LASTEXITCODE -ne 0 -or $actualVersion.Trim() -ne $version) { throw 'Downloaded CLI failed verification.' }
  $installation = "$version-" + [Guid]::NewGuid().ToString('N')
  $target = Join-Path $installRoot "versions/$installation"
  New-Item -ItemType Directory -Path (Join-Path $installRoot 'versions') -Force | Out-Null
  $versionStage = Join-Path $stage 'version'
  New-Item -ItemType Directory -Path $versionStage | Out-Null
  Move-Item -LiteralPath $unpacked -Destination (Join-Path $versionStage 'mukai')
  Move-Item -LiteralPath $versionStage -Destination $target
  $runtime = "%~dp0..\versions\$installation\mukai\runtime\node.exe"
  $entry = "%~dp0..\versions\$installation\mukai\app\cli.cjs"
  $text = "@echo off`r`nrem Mukai CLI launcher`r`n`"$runtime`" `"$entry`" %*`r`nexit /b %errorlevel%`r`n"
  $newLauncher = Join-Path $stage 'mukai.cmd'
  [IO.File]::WriteAllText($newLauncher, $text, [Text.Encoding]::Default)
  Move-Item -LiteralPath $newLauncher -Destination $launcher -Force
  if ($env:MUKAI_NO_MODIFY_PATH -ne '1') {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if ($entries -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User') }
    if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
  }
  Write-Output "Installed Mukai $version. Run: mukai serve --open"
  Write-Output 'Restart other terminals to pick up PATH. Re-run the installer to upgrade; data is preserved.'
} finally {
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  if (!$resolvedStage.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path.' }
  if ([IO.Directory]::Exists($resolvedStage)) {
    $extended = if ($resolvedStage.StartsWith('\\')) { '\\?\UNC\' + $resolvedStage.Substring(2) } else { '\\?\' + $resolvedStage }
    [IO.Directory]::Delete($extended, $true)
  }
}
