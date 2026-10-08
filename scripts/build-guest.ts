import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const directory = resolve('dist/guest');
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: ['src/server/computer/guest.ts', 'src/server/computer/guest-worker.ts'],
    outdir: directory,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
  });
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
    packages: Record<string, { version: string }>;
  };
  const dependencies = Object.fromEntries(
    ['ai', 'zod', 'sharp', 'playwright-core'].map((name) => [
      name,
      lock.packages['node_modules/' + name].version,
    ]),
  );
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'mukai-guest',
        private: true,
        version: '0.1.0',
        engines: { node: '>=24' },
        dependencies,
      },
      null,
      2,
    ) + '\n',
  );
  for (const file of ['install.sh', 'protect.sh', 'systemctl-guard.sh', 'mukai-guest.service'])
    await writeFile(
      resolve(directory, file),
      (await readFile(resolve('scripts/guest', file), 'utf8')).replace(/\r\n/g, '\n'),
    );
  console.log('Guest bundle ready in dist/guest. See docs/qemu-workspaces.md.');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
