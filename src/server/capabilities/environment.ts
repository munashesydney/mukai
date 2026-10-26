import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database';
import { privateSecret } from '../config';
import type { EnvironmentVariable } from '../../shared/customCapabilities';
import { environmentVariableName, missingEnvironmentError } from '../../shared/terminal';
import { ApiError } from '../config';

export const variableName = environmentVariableName;
export class CapabilityEnvironment {
  private key: Buffer;
  // Keep old values redacted too, including after rotation/deletion.
  private secrets = new Set<string>();
  constructor(
    private db: Database,
    private registerSecret: (value: string) => void = () => {},
  ) {
    this.key = privateSecret(db.dir, 'credentials.key', 32);
    for (const row of db.all('SELECT value FROM capability_env')) this.decrypt(String(row.value));
  }
  decrypt(value: string, trackSecret = true) {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    const result = Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      'utf8',
    );
    if (result && trackSecret) {
      this.secrets.add(result);
      this.registerSecret(result);
    }
    return result;
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  save(workspaceId: string, entries: { name: string; value: string }[]) {
    const values = z
      .array(z.object({ name: variableName, value: z.string().max(16384) }))
      .max(200)
      .parse(entries);
    this.db.transaction(() => {
      for (const { name, value } of values) {
        const encrypted = this.encrypt(value);
        this.db.run(
          'INSERT INTO capability_env VALUES(?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET value=excluded.value',
          workspaceId,
          name,
          encrypted,
        );
        if (value) {
          this.secrets.add(value);
          this.registerSecret(value);
        }
      }
    });
  }
  remove(workspaceId: string, name: string) {
    this.db.run(
      'DELETE FROM capability_env WHERE workspace_id=? AND name=?',
      workspaceId,
      variableName.parse(name),
    );
  }
  list(workspaceId: string): EnvironmentVariable[] {
    const definitions = this.db
      .all('SELECT definition_json FROM capabilities WHERE workspace_id=?', workspaceId)
      .map(
        (row) => JSON.parse(String(row.definition_json)) as { name: string; requiredEnv: string[] },
      );
    const names = new Set(
      this.db
        .all('SELECT name FROM capability_env WHERE workspace_id=?', workspaceId)
        .map((row) => String(row.name)),
    );
    for (const definition of definitions)
      for (const name of definition.requiredEnv) names.add(name);
    return [...names].sort().map((name) => ({
      name,
      configured: Boolean(this.resolve(workspaceId, [name])[name]),
      usedBy: definitions.filter((d) => d.requiredEnv.includes(name)).map((d) => d.name),
    }));
  }
  resolve(workspaceId: string, names: string[]) {
    const result: Record<string, string> = Object.create(null);
    for (const name of names) {
      const row = this.db.get(
        'SELECT value FROM capability_env WHERE workspace_id=? AND name=?',
        workspaceId,
        name,
      );
      if (row) result[name] = this.decrypt(String(row.value));
    }
    return result;
  }
  resolveForTerminal(workspaceId: string, names: string[]) {
    const values = this.resolve(workspaceId, names);
    const missing = [...new Set(names.filter((name) => !values[name]))];
    if (missing.length) throw new ApiError(400, missingEnvironmentError(missing));
    return values;
  }
  redact(text: string) {
    for (const secret of this.secrets) {
      text = text
        .split(secret)
        .join('[redacted]')
        .split(encodeURIComponent(secret))
        .join('[redacted]');
      const encoded = Buffer.from(secret).toString('base64');
      text = text.split(encoded).join('[redacted]');
    }
    return text;
  }
  publicValue(value: unknown): unknown {
    // Transform strings and object keys without damaging JSON syntax.
    const redact = (item: unknown): unknown => {
      if (typeof item === 'string') return this.redact(item);
      if (Array.isArray(item)) return item.map(redact);
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, value]) => [this.redact(key), redact(value)]),
        );
      return item;
    };
    return redact(value ?? null);
  }
}
