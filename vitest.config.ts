import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'mukai_memory/tests/**/*.test.ts'],
    // Native databases and PowerShell processes contend when every file runs at once.
    maxWorkers: 4,
  },
});
