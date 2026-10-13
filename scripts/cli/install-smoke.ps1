$ErrorActionPreference = 'Stop'
$taskRoot = (Get-Location).Path
$version = (Get-Content -LiteralPath (Join-Path $taskRoot 'dist/cli/manifest.json') -Raw | ConvertFrom-Json).version
$taskArchive = Join-Path $taskRoot "release/mukai-cli-$version-win32-x64.zip"
$taskHash = [Security.Cryptography.SHA256]::Create()
$taskStream = [IO.File]::OpenRead($taskArchive)
try { $taskChecksum = [BitConverter]::ToString($taskHash.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
finally { $taskStream.Dispose(); $taskHash.Dispose() }
$taskInstaller = Join-Path $taskRoot 'installers/install.ps1'
$taskTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$taskTestDirectory = Join-Path $taskTemporaryRoot ('mukai-cli-install-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
$taskOriginalPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:LOCALAPPDATA = $taskTestDirectory
$env:MUKAI_NO_MODIFY_PATH = '1'
$env:MUKAI_VERSION = $version
$global:MukaiInstallerTestBadChecksum = $false
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  if ($OutFile) { Copy-Item -LiteralPath $taskArchive -Destination $OutFile; return }
  $checksum = if ($global:MukaiInstallerTestBadChecksum) { '0' * 64 } else { $taskChecksum }
  # GitHub serves release assets as application/octet-stream, so Windows PowerShell 5.1 returns byte[] rather than text.
  return [pscustomobject]@{ Content = [Text.Encoding]::UTF8.GetBytes("$checksum  mukai-cli-$version-win32-x64.zip`n") }
}
try {
  & $taskInstaller
  $launcher = Join-Path $taskTestDirectory 'MukaiCLI/bin/mukai.cmd'
  if ((& $launcher --version).Trim() -ne $version) { throw 'Installed launcher returned the wrong version.' }
  $first = Get-Content -LiteralPath $launcher -Raw
  & $taskInstaller
  $second = Get-Content -LiteralPath $launcher -Raw
  if ($first -eq $second) { throw 'Reinstall must activate a fresh version directory.' }
  $global:MukaiInstallerTestBadChecksum = $true
  $rejected = $false
  try { & $taskInstaller } catch { if ($_.Exception.Message -match 'checksum') { $rejected = $true } else { throw } }
  if (!$rejected) { throw 'Corrupt archive was not rejected.' }
  if ((Get-Content -LiteralPath $launcher -Raw) -ne $second) { throw 'Failed installation changed the active launcher.' }
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -ne $taskOriginalPath) { throw 'Isolated installer test modified user PATH.' }
  # Arch detection must read environment variables instead of .NET: RuntimeInformation's
  # architecture getter is unavailable on some Windows PowerShell 5.1 hosts, which made the
  # installer throw "You cannot call a method on a null-valued expression." before it
  # downloaded anything. Guard against reintroducing that dependency.
  if ((Get-Content -LiteralPath $taskInstaller -Raw) -match 'RuntimeInformation\s*\]::\s*OSArchitecture') {
    throw 'Installer arch detection regressed to RuntimeInformation::OSArchitecture.'
  }
  $taskArch = $env:PROCESSOR_ARCHITECTURE
  $taskWowArch = $env:PROCESSOR_ARCHITEW6432
  try {
    Remove-Item Env:\PROCESSOR_ARCHITEW6432 -ErrorAction SilentlyContinue
    $env:PROCESSOR_ARCHITECTURE = 'X86'
    $archRejected = $false
    try { & $taskInstaller } catch { if ($_.Exception.Message -match 'x64 only') { $archRejected = $true } else { throw } }
    if (!$archRejected) { throw 'Non-x64 architecture was not rejected.' }
  } finally {
    $env:PROCESSOR_ARCHITECTURE = $taskArch
    if ($null -eq $taskWowArch) { Remove-Item Env:\PROCESSOR_ARCHITEW6432 -ErrorAction SilentlyContinue } else { $env:PROCESSOR_ARCHITEW6432 = $taskWowArch }
  }
  Write-Output 'Installer smoke passed: verified download, working command, safe reinstall, failed-upgrade preservation, non-x64 rejection, no user PATH changes.'
} finally {
  $resolved = [IO.Path]::GetFullPath($taskTestDirectory)
  if (!$resolved.StartsWith($taskTemporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^mukai-cli-install-[a-f0-9]{6}$') { throw 'Unsafe test cleanup path.' }
  if ([IO.Directory]::Exists($resolved)) {
    $extended = if ($resolved.StartsWith('\\')) { '\\?\UNC\' + $resolved.Substring(2) } else { '\\?\' + $resolved }
    [IO.Directory]::Delete($extended, $true)
  }
}
