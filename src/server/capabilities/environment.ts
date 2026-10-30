import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database';
import { privateSecret } from '../config';
import type { EnvironmentVariable } from '../../shared/customCapabilities';
import { environmentVariableName, missingEnvironmentError } from '../../shared/terminal';
import { ApiError } from '../config';
import { CapabilityRedactor } from './redaction';
import { serializeDotEnv } from '../../shared/dotEnv';

export const variableName = environmentVariableName;
export class CapabilityEnvironment {
  private key: Buffer;
  // Keep old values redacted too, including after rotation/deletion.
  private secrets = new Set<string>();
  private retired = new Set<string>();
  private runtimeSecrets = new Set<string>();
  trackRuntimeSecret(value: string) {
    this.runtimeSecrets.add(value);
    this.refreshSecrets();
    return () => {
      this.runtimeSecrets.delete(value);
      this.refreshSecrets();
    };
  }
  private redactor = new CapabilityRedactor(new Set());
  constructor(
    private db: Database,
    private registerSecret: (value: string) => void = () => {},
  ) {
    this.key = privateSecret(db.dir, 'credentials.key', 32);
    this.refreshSecrets();
  }
  decrypt(value: string, trackSecret = true) {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    const result = Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      'utf8',
    );
    if (result && trackSecret) {
      this.retired.add(result);
      this.registerSecret(result);
      this.refreshSecrets();
    }
    return result;
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private refreshSecrets() {
    this.secrets = new Set([...this.retired, ...this.runtimeSecrets]);
    for (const row of this.db.all('SELECT value FROM capability_env WHERE secret=1')) {
      const value = this.decrypt(String(row.value), false);
      if (value) {
        this.secrets.add(value);
        this.registerSecret(value);
      }
    }
    this.redactor = new CapabilityRedactor(this.secrets);
  }
  save(workspaceId: string, entries: { name: string; value: string; secret?: boolean }[]) {
    const values = z
      .array(
        z.object({
          name: variableName,
          value: z.string().max(16384),
          secret: z.boolean().optional(),
        }),
      )
      .max(200)
      .parse(entries);
    const retired: string[] = [];
    this.db.transaction(() => {
      for (const { name, value, secret } of values) {
        const previous = this.db.get(
          'SELECT value,secret FROM capability_env WHERE workspace_id=? AND name=?',
          workspaceId,
          name,
        );
        const old = previous ? this.decrypt(String(previous.value), false) : '';
        if (previous?.secret && old && old !== value) retired.push(old);
        this.db.run(
          'INSERT INTO capability_env(workspace_id,name,value,secret) VALUES(?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET value=excluded.value,secret=excluded.secret',
          workspaceId,
          name,
          this.encrypt(value),
          secret === undefined ? Number(previous?.secret ?? 1) : Number(secret),
        );
      }
    });
    for (const value of retired) this.retired.add(value);
    this.refreshSecrets();
  }
  setSensitivity(workspaceId: string, name: string, secret: boolean) {
    variableName.parse(name);
    z.boolean().parse(secret);
    if (
      !this.db.get(
        'SELECT name FROM capability_env WHERE workspace_id=? AND name=?',
        workspaceId,
        name,
      )
    )
      throw new ApiError(404, 'Save this variable before changing its sensitivity.');
    this.db.run(
      'UPDATE capability_env SET secret=? WHERE workspace_id=? AND name=?',
      Number(secret),
      workspaceId,
      name,
    );
    this.refreshSecrets();
  }
  remove(workspaceId: string, name: string) {
    variableName.parse(name);
    const previous = this.db.get(
      'SELECT value,secret FROM capability_env WHERE workspace_id=? AND name=?',
      workspaceId,
      name,
    );
    if (previous?.secret) {
      const value = this.decrypt(String(previous.value), false);
      if (value) this.retired.add(value);
    }
    this.db.run('DELETE FROM capability_env WHERE workspace_id=? AND name=?', workspaceId, name);
    this.refreshSecrets();
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
      secret: Boolean(
        this.db.get(
          'SELECT secret FROM capability_env WHERE workspace_id=? AND name=?',
          workspaceId,
          name,
        )?.secret ?? 1,
      ),
      usedBy: definitions.filter((d) => d.requiredEnv.includes(name)).map((d) => d.name),
    }));
  }
  /** Explicit developer download only; ordinary discovery never returns values. */
  export(workspaceId: string) {
    return serializeDotEnv(
      this.db
        .all(
          'SELECT name,value FROM capability_env WHERE workspace_id=? ORDER BY name',
          workspaceId,
        )
        .map((row) => ({ name: String(row.name), value: this.decrypt(String(row.value), false) })),
    );
  }
  resolve(workspaceId: string, names: string[]) {
    const result: Record<string, string> = Object.create(null);
    for (const name of names) {
      const row = this.db.get(
        'SELECT value,secret FROM capability_env WHERE workspace_id=? AND name=?',
        workspaceId,
        name,
      );
      if (row) result[name] = this.decrypt(String(row.value), false);
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
    return this.redactor.text(text).value;
  }
  redactText(text: string) {
    return this.redactor.text(text);
  }
  publicValue(value: unknown): unknown {
    return this.redactor.value(value ?? null).value;
  }
  redactResponse(value: unknown, json = false) {
    if (typeof value === 'string') {
      const parsed = this.redactor.json(value);
      if (parsed) return parsed;
      if (json)
        throw new ApiError(
          400,
          'Route returned invalid JSON. Return an object or valid JSON text for a JSON content type.',
        );
      return this.redactor.text(value);
    }
    return this.redactor.value(value ?? null);
  }
}
