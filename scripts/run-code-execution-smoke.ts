import { build } from 'esbuild';
import { createPackage } from '@electron/asar';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mukai-code-package-'));
  const stage = join(root, 'app');
  const load = createRequire(join(process.cwd(), 'package.json'));
  try {
    await mkdir(stage);
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify({ name: 'code-execution-smoke', version: '1.0.0', main: 'index.cjs' }),
    );
    await build({
      entryPoints: ['scripts/code-execution-smoke.ts'],
      outfile: join(stage, 'index.cjs'),
      bundle: true,
      platform: 'node',
      target: 'node24',
      packages: 'external',
      format: 'cjs',
    });
    const copied = new Set<string>();
    const copyDependency = async (name: string) => {
      if (copied.has(name)) return;
      copied.add(name);
      // Some QuickJS packages do not export package.json; their pinned runtime
      // dependencies are installed together in this project's node_modules.
      const path = join(process.cwd(), 'node_modules', name, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      await cp(dirname(path), join(stage, 'node_modules', name), { recursive: true });
      for (const dependency of Object.keys(manifest.dependencies || {}))
        await copyDependency(dependency);
    };
    await copyDependency('quickjs-emscripten');
    const archive = join(root, 'app.asar');
    await createPackage(stage, archive);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(load('electron') as string, [archive], {
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 30000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
