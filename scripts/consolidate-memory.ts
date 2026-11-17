#!/usr/bin/env npx tsx
/**
 * Reports or folds duplicate memory claims for one database, offline.
 *
 * Mukai's write path refuses to store a second served row for a claim it already holds, but rows
 * written before that rule existed can still be duplicated. The same operation is available while
 * Mukai runs at `POST /api/memory/consolidate`; this script exists so it can also be run against a
 * stopped server, or rehearsed against a copy of a database first.
 *
 *   npx tsx scripts/consolidate-memory.ts <database> [report|apply]
 *
 * `report` is the default and writes nothing. A merge keeps the earliest start, the strongest state
 * and every source, and never touches a row with an end date: a closed span is another era, not a
 * duplicate.
 *
 * Opening a memory store resets an interrupted episode to pending, and Mukai keeps its database in WAL
 * mode, so run this while Mukai is stopped: from a second connection it could reset a capture that is
 * mid-flight. Rehearse against a `VACUUM INTO` snapshot before applying it to a database you care about.
 */
import { DatabaseSync } from 'node:sqlite';
import { MemoryEngine, SQLiteMemoryStore } from '../mukai_memory/src';

const [path, mode = 'report'] = process.argv.slice(2);
if (!path)
  throw new Error('usage: npx tsx scripts/consolidate-memory.ts <database> [report|apply]');
if (mode !== 'report' && mode !== 'apply') throw new Error("mode must be 'report' or 'apply'");
const store = new SQLiteMemoryStore(new DatabaseSync(path));
// Consolidation reads and rewrites rows only; nothing here asks a model anything.
const engine = new MemoryEngine(store, async () => ({ facts: [] }));
const served = (workspaceId: string) =>
  store.get(
    'SELECT COUNT(*) AS n FROM memory_facts WHERE workspace_id=? AND valid_to IS NULL AND superseded_by IS NULL',
    workspaceId,
  )?.n;

let groups = 0;
let removed = 0;
for (const workspace of store.all(
  'SELECT id,name FROM workspaces WHERE deleting=0 ORDER BY name',
)) {
  const workspaceId = String(workspace.id);
  const before = Number(served(workspaceId) ?? 0);
  const report = engine.consolidateClaims({ workspaceId, includePrivate: true }, mode === 'apply');
  if (!report.groups) continue;
  const verb = mode === 'apply' ? 'folded' : 'to fold';
  const after = before - report.removed;
  console.log(
    `${workspace.name}: ${report.groups} duplicated claim(s), ${report.removed} row(s) ${verb}, ` +
      `${report.sourcesMoved} source(s) ${mode === 'apply' ? 'moved' : 'to move'} ` +
      `(${before} -> ${after} served${mode === 'apply' ? '' : ' if applied'})`,
  );
  for (const claim of report.claims.slice(0, 25))
    console.log(`  ${claim.text.slice(0, 92)}  [kept 1, folded ${claim.removed.length}]`);
  if (report.claims.length > 25) console.log(`  ... ${report.claims.length - 25} more`);
  groups += report.groups;
  removed += report.removed;
}
console.log(
  `\n${mode === 'apply' ? 'folded' : 'found'} ${removed} redundant row(s) across ${groups} claim(s).`,
);
if (mode === 'apply')
  console.log(
    'integrity:',
    store.get('PRAGMA integrity_check')?.integrity_check,
    '| orphan sources:',
    store.get(
      'SELECT COUNT(*) AS n FROM memory_fact_sources s WHERE NOT EXISTS(SELECT 1 FROM memory_facts f WHERE f.id=s.fact_id)',
    )?.n,
    '| orphan index rows:',
    store.get(
      'SELECT COUNT(*) AS n FROM memory_fts t WHERE NOT EXISTS(SELECT 1 FROM memory_facts f WHERE f.id=t.fact_id)',
    )?.n,
    '| foreign keys:',
    store.all('PRAGMA foreign_key_check').length,
  );
