import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../db/database';
import { FileChangeRepository } from './fileChangeRepository';

let dir: string, database: Database, changes: FileChangeRepository;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-changes-'));
  database = new Database(dir);
  database.run(
    "INSERT INTO bots(id,name,description,instructions,avatar,created_at,workspace_id) VALUES('bot','Bot','','','scout','2026-10-02','default')",
  );
  for (const id of ['turn', 'later'])
    database.run(
      "INSERT INTO messages(id,bot_id,request_id,role,status,created_at) VALUES(?,'bot',?,'assistant','complete','2026-10-02')",
      id,
      id,
    );
  changes = new FileChangeRepository(database);
});
afterEach(() => {
  database.db.close();
  expect(dir.startsWith(join(tmpdir(), 'mukai-changes-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
describe('Per-turn file snapshots', () => {
  it('retains the first before and last after, without double-counting repeated edits or later turns', () => {
    changes.record('bot', 'turn', { path: 'file.ts', before: 'old\n', after: 'intermediate\n' });
    const id = changes.forMessage('turn')[0].id;
    changes.record('bot', 'turn', { path: 'file.ts', before: 'intermediate\n', after: 'new\n' });
    expect(changes.forMessage('turn')).toEqual([
      { id, messageId: 'turn', path: 'file.ts', kind: 'edited', added: 1, removed: 1 },
    ]);
    expect(changes.find(id)).toMatchObject({ before: 'old\n', after: 'new\n' });
    changes.record('bot', 'later', { path: 'file.ts', before: 'new\n', after: 'later\n' });
    expect(changes.find(id)).toMatchObject({ before: 'old\n', after: 'new\n' });
  });
  it('omits unchanged files and edits that return to their original contents', () => {
    changes.record('bot', 'turn', { path: 'file.ts', before: 'same', after: 'same' });
    expect(changes.forMessage('turn')).toEqual([]);
    changes.record('bot', 'turn', { path: 'file.ts', before: 'original', after: 'changed' });
    changes.record('bot', 'turn', { path: 'file.ts', before: 'changed', after: 'original' });
    expect(changes.forMessage('turn')).toEqual([]);
  });
  it('keeps created empty files and cascades saved diffs when the message is deleted', () => {
    changes.record('bot', 'turn', { path: 'empty.ts', before: null, after: '' });
    const file = changes.forMessage('turn')[0];
    expect(file).toMatchObject({ kind: 'created', added: 0, removed: 0 });
    database.run('DELETE FROM messages WHERE id=?', 'turn');
    expect(changes.find(file.id)).toBeUndefined();
  });
});
