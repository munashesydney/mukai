import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './db/database';
import { migrations } from './db/migrations';
import { seedTestBot } from './testFixtures';

it('backs up legacy tool selections, enables all-tools defaults once, and retains later restrictions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mukai-tool-defaults-'));
  let db = new Database(dir);
  try {
    seedTestBot(db);
    // Reconstruct the previous schema so the actual upgrade is exercised on reopen.
    db.run('DROP TABLE legacy_bot_tool_assignments');
    const version =
      migrations.findIndex((sql) => sql.includes('CREATE TABLE legacy_bot_tool_assignments')) + 1;
    expect(version).toBeGreaterThan(0);
    db.run('DELETE FROM schema_migrations WHERE version=?', version);
    db.run('INSERT INTO bot_tool_assignments VALUES(?,?,?)', 'scout', 'browser', 0);
    db.db.close();
    db = new Database(dir);
    expect(db.all('SELECT * FROM bot_tool_assignments')).toEqual([]);
    expect(db.all('SELECT * FROM legacy_bot_tool_assignments')).toEqual([
      { bot_id: 'scout', tool_id: 'browser', enabled: 0 },
    ]);
    db.run('INSERT INTO bot_tool_assignments VALUES(?,?,?)', 'scout', 'terminal', 0);
    db.db.close();
    db = new Database(dir);
    expect(db.all('SELECT * FROM bot_tool_assignments')).toEqual([
      { bot_id: 'scout', tool_id: 'terminal', enabled: 0 },
    ]);
  } finally {
    db.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
