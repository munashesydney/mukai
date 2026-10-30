import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultSkills } from '../../skills';

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it.each(['desktop', 'cli', 'server'] as const)(
  'loads normal Markdown in an isolated %s distribution without the source checkout or its working directory',
  async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'mukai-skill-assets-'));
    directories.push(root);
    let entry: string;
    if (layout === 'server') {
      const output = join(root, 'src/skills');
      await build({
        entryPoints: [
          'src/skills/index.ts',
          'src/skills/bundle.ts',
          ...(await readdir('src/skills', { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => join('src/skills', entry.name, 'index.ts')),
        ],
        outbase: 'src/skills',
        outdir: output,
        platform: 'node',
        format: 'cjs',
      });
      await cp('src/skills', output, { recursive: true });
      entry = join(output, 'index.js');
    } else {
      entry = join(root, layout === 'desktop' ? 'out/main/index.cjs' : 'app/cli.cjs');
      await build({
        entryPoints: ['src/skills/index.ts'],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      });
      const packageRoot = layout === 'desktop' ? root : dirname(entry);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'mukai' }));
      await cp('src/skills', join(packageRoot, 'src/skills'), { recursive: true });
    }
    const { stdout } = await run(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).defaultSkills))', entry],
      { cwd: tmpdir() },
    );
    expect(JSON.parse(stdout)).toEqual(defaultSkills);
  },
);
it('fails clearly when a packaged skill asset is missing instead of silently loading a checkout copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mukai-missing-skill-'));
  directories.push(root);
  const entry = join(root, 'out/main/index.cjs');
  await mkdir(dirname(entry), { recursive: true });
  await build({
    entryPoints: [resolve('src/skills/index.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mukai' }));
  await expect(
    run(process.execPath, ['-e', 'require(process.argv[1])', entry], { cwd: tmpdir() }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('SKILL.md') });
});
