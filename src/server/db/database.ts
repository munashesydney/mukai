import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrations, rebuildMigrations } from './migrations';

export type Row = Record<string, string | number | null>;
export class Database {
  readonly db: DatabaseSync;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'mukai.sqlite'));
    this.db.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const latestVersion = Number(
      this.get('SELECT MAX(version) AS version FROM schema_migrations')?.version || 0,
    );
    if (latestVersion > migrations.length) {
      this.db.close();
      throw new Error('This database needs a newer version of Mukai.');
    }
    try {
      migrations.forEach((sql, index) => {
        if (!this.get('SELECT version FROM schema_migrations WHERE version = ?', index + 1)) {
          const rebuild = rebuildMigrations.has(index + 1);
          if (rebuild) this.db.exec('PRAGMA foreign_keys = OFF');
          try {
            this.transaction(() => {
              this.db.exec(sql);
              if (rebuild && this.all('PRAGMA foreign_key_check').length)
                throw new Error('Database upgrade failed its foreign-key check.');
              this.run(
                'INSERT INTO schema_migrations VALUES (?,?)',
                index + 1,
                new Date().toISOString(),
              );
            });
          } finally {
            if (rebuild) this.db.exec('PRAGMA foreign_keys = ON');
          }
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  all(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
