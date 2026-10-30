import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  // A clean output also removes stale modules when a skill moves into a folder.
  await rm(resolve('dist/server'), { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.server.json'],
    {
      stdio: 'inherit',
    },
  );
  // tsc emits JavaScript only; ship Markdown and supporting assets beside it.
  await cp(resolve('src/skills'), resolve('dist/server/src/skills'), { recursive: true });
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
