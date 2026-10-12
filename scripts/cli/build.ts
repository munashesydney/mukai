import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  await rm(resolve('dist/cli'), { recursive: true, force: true });
  await mkdir('dist/cli/app', { recursive: true });
  await build({
    entryPoints: ['src/cli/index.ts'],
    outfile: 'dist/cli/app/cli.cjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    define: { __MUKAI_VERSION__: JSON.stringify(manifest.version) },
    sourcemap: true,
  });
  await cp('dist/web', 'dist/cli/web', { recursive: true });
  await cp('dist/guest', 'dist/cli/resources/guest', { recursive: true });
  await cp('dist/computer_use', 'dist/cli/resources/computer_use', { recursive: true });
  await writeFile(
    resolve('dist/cli/manifest.json'),
    JSON.stringify(
      {
        product: 'mukai-cli',
        version: manifest.version,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('CLI build ready in dist/cli. Run npm run cli -- serve --open for development.');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
