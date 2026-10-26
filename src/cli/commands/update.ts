import { runtimePaths, version } from '../runtime';
import {
  activateUpdate,
  compareVersions,
  findInstallation,
  latestRelease,
  prepareUpdate,
} from '../installation';

export async function update() {
  const host = await findInstallation(runtimePaths().root);
  if (!host)
    throw new Error(
      'CLI updates require an installer-managed release. Re-run the Mukai CLI installer to upgrade this copy.',
    );
  console.log('Checking for CLI updates…');
  const release = await latestRelease(host);
  if (compareVersions(release.version, version()) <= 0) {
    console.log(`Mukai ${version()} is up to date.`);
    return 0;
  }
  console.log(`Downloading Mukai ${release.version}…`);
  const prepared = await prepareUpdate(host, release, () => {});
  await activateUpdate(host, prepared);
  console.log(
    `Mukai ${release.version} is installed. Restart any running CLI server to use it. Application data is preserved.`,
  );
  return 0;
}
