import {
  DEFAULT_PURSUIT_CONCURRENCY,
  MAX_PURSUIT_CONCURRENCY,
  type LimitsSettings,
} from '../../shared/limits';
import type { Database } from '../db/database';

export class LimitsRepository {
  constructor(private store: Database) {}
  get(): LimitsSettings {
    const saved = Number(
      this.store.get('SELECT value FROM metadata WHERE key=?', 'pursuit-concurrency')?.value,
    );
    return {
      pursuitConcurrency:
        Number.isInteger(saved) && saved >= 1 && saved <= MAX_PURSUIT_CONCURRENCY
          ? saved
          : DEFAULT_PURSUIT_CONCURRENCY,
    };
  }
  save(value: LimitsSettings) {
    this.store.run(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'pursuit-concurrency',
      String(value.pursuitConcurrency),
    );
    return this.get();
  }
}
