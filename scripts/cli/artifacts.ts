export const cliTargets = [
  { platform: 'win32', arch: 'x64', extension: 'zip' },
  { platform: 'darwin', arch: 'x64', extension: 'tar.gz' },
  { platform: 'darwin', arch: 'arm64', extension: 'tar.gz' },
  { platform: 'linux', arch: 'x64', extension: 'tar.gz' },
] as const;
export function cliArchiveName(version: string, platform: string, arch: string) {
  const target = cliTargets.find((value) => value.platform === platform && value.arch === arch);
  if (!target) throw new Error(`Unsupported CLI platform: ${platform}/${arch}`);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid CLI version');
  return `mukai-cli-${version}-${platform}-${arch}.${target.extension}`;
}
