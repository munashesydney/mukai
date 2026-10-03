import type { Database } from '../db/database';
import type { ProviderRecord } from '../models/entities';
import { providerRecord } from './records';

export class ProviderRepository {
  constructor(private database: Database) {}
  list() {
    return this.database
      .all('SELECT * FROM providers ORDER BY is_default DESC,name')
      .map(providerRecord);
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM providers WHERE id = ?', id);
    return row ? providerRecord(row) : undefined;
  }
  default() {
    const row = this.database.get('SELECT * FROM providers WHERE is_default = 1');
    return row ? providerRecord(row) : undefined;
  }
  save(provider: ProviderRecord) {
    this.database.transaction(() => {
      if (provider.isDefault) this.database.run('UPDATE providers SET is_default = 0');
      this.database.run(
        `INSERT INTO providers(id,name,kind,base_url,default_model,supports_images,is_default,encrypted_key,context_window_tokens,max_output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,default_model=excluded.default_model,supports_images=excluded.supports_images,is_default=excluded.is_default,encrypted_key=excluded.encrypted_key,context_window_tokens=excluded.context_window_tokens,max_output_tokens=excluded.max_output_tokens`,
        provider.id,
        provider.name,
        provider.kind,
        provider.baseUrl,
        provider.defaultModel,
        Number(provider.supportsImages),
        Number(provider.isDefault),
        provider.encryptedKey,
        provider.contextWindowTokens ?? null,
        provider.maxOutputTokens ?? 8192,
      );
    });
  }
  delete(id: string) {
    this.database.transaction(() => {
      this.database.run('DELETE FROM providers WHERE id = ?', id);
      if (!this.default()) {
        const next = this.database.get('SELECT id FROM providers ORDER BY name LIMIT 1');
        if (next) this.database.run('UPDATE providers SET is_default = 1 WHERE id = ?', next.id);
      }
    });
  }
}
