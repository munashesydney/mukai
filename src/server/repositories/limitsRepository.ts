import {
  DEFAULT_PURSUIT_CONCURRENCY,
  MAX_PURSUIT_CONCURRENCY,
  DEFAULT_AI_CONCURRENCY,
  MAX_AI_CONCURRENCY,
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
      aiConcurrency: this.readAI(),
      pursuitConcurrency:
        Number.isInteger(saved) && saved >= 1 && saved <= MAX_PURSUIT_CONCURRENCY
          ? saved
          : DEFAULT_PURSUIT_CONCURRENCY,
    };
  }
  private readAI() {
    const saved = Number(
      this.store.get('SELECT value FROM metadata WHERE key=?', 'ai-concurrency')?.value,
    );
    return Number.isInteger(saved) && saved >= 1 && saved <= MAX_AI_CONCURRENCY
      ? saved
      : DEFAULT_AI_CONCURRENCY;
  }
  save(value: LimitsSettings) {
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'ai-concurrency',
        String(value.aiConcurrency),
      );
      this.store.run(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'pursuit-concurrency',
        String(value.pursuitConcurrency),
      );
    });
    return this.get();
  }
}
