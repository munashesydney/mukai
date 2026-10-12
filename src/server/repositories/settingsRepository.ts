import type { Database } from '../db/database';

/** Shared application preferences; reuse the existing app_settings table and stable keys. */
export class SettingsRepository {
  constructor(private readonly store: Database) {}
  get(key: string): string | null {
    const row = this.store.get('SELECT value FROM app_settings WHERE key=?', key);
    return row ? String(row.value) : null;
  }
  set(key: string, value: string) {
    this.store.run(
      'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
  initialize(key: string, value: string) {
    // A legacy desktop cache must never replace an appearance already saved by another client.
    this.store.run('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)', key, value);
  }
}
