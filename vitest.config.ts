import { defineConfig } from 'vitest/config';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// macOS can expose TMPDIR through the /var symlink. Fixtures need canonical
// paths so workspace link protection tests the fixture rather than that alias.
if (process.platform === 'darwin') process.env.TMPDIR = realpathSync(tmpdir());

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'mukai_memory/tests/**/*.test.ts'],
    // Native databases and PowerShell processes contend when every file runs at once.
    maxWorkers: 4,
  },
});
