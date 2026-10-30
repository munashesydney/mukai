import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SkillBundle } from '../shared/skills';

/** Resolve source, compiled-server, CLI and Electron/asar layouts without using cwd. */
function skillFolder(name: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid bundled skill name.');
  for (const root of [__dirname, join(__dirname, 'src', 'skills')]) {
    const folder = join(root, name);
    if (existsSync(folder)) return folder;
  }
  // Bundled desktop and smoke entry points live below the Mukai package root.
  for (let directory = __dirname; ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (metadata.name === 'mukai') return join(directory, 'src', 'skills', name);
    }
    if (dirname(directory) === directory) break;
  }
  throw new Error(`Bundled skill assets are missing: ${name}`);
}

/** Each skill's index lists its normal SKILL.md and supporting files. */
export function bundledSkill(name: string, paths: readonly string[]): SkillBundle {
  const folder = skillFolder(name);
  return {
    files: paths.map((path) => {
      if (
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Bundled skill files must use relative paths.');
      return { path, encoding: 'utf8', content: readFileSync(join(folder, path), 'utf8') };
    }),
  };
}
