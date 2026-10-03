import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  validateHeaderName,
  validateHeaderValue,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { buildCapability } from './compiler';
import Ajv from 'ajv';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Database, Row } from '../db/database';
import { ApiError } from '../config';
import type { WorkspaceService } from '../services/workspaceService';
import { WorkspaceFileService } from '../services/workspaceFileService';
import { body } from '../http/transport';
import type { Bot, ChatActivity } from '../../shared/ai';
import type {
  CapabilityDefinition,
  CapabilityRegistration,
  CapabilityRun,
  CustomResponse,
} from '../../shared/customCapabilities';
import { CapabilityEnvironment, variableName } from './environment';
import { workerSource } from './worker';

const responseSchema = z.object({
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
  body: z.unknown().optional(),
});
function validateResponse(value: unknown) {
  const response = responseSchema.parse(value);
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (
      /^(connection|transfer-encoding|content-length|upgrade|keep-alive|proxy-authenticate|proxy-authorization|trailer|access-control-.*)$/i.test(
        name,
      )
    )
      throw new ApiError(400, 'Handler returned a reserved HTTP header.');
    validateHeaderName(name);
    validateHeaderValue(name, value);
  }
  return response;
}

const reserved = new Set([
  'file_operations',
  'terminal',
  'process',
  'browser',
  'manage_pursuit',
  'report_pursuit',
  'register_custom_tool',
  'register_custom_route',
]);
const definitionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  description: z.string().min(1).max(4000).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  requiredEnv: z.array(variableName).max(100),
  timeoutMs: z.number().int().min(100).max(30000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  path: z.string().max(512).optional(),
  auth: z.enum(['mukai', 'handler', 'public']).optional(),
  hasJobHandler: z.boolean(),
});
export const registrationInput = z.object({
  operation: z.enum(['register', 'update', 'enable', 'disable', 'remove', 'list', 'inspect']),
  id: z.string().max(100).optional(),
  modulePath: z.string().min(1).max(512).optional(),
  exportName: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/)
    .default('default'),
});

export class CapabilityService {
  readonly environment: CapabilityEnvironment;
  private ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  private workers = new Set<Worker>();
  private timer?: ReturnType<typeof setInterval>;
  private queueRun?: Promise<void>;
  private closing = false;
  private pending = new Set<Promise<unknown>>();
  private wake?: (
    botId: string,
    workspaceId: string,
    message: string,
    requestId: string,
  ) => Promise<void>;
  private versions = new Map<string, CapabilityDefinition>();
  private failures = new Map<string, string>();
  private localBaseUrl = '';
  setLocalBaseUrl(value: string) {
    this.localBaseUrl = value;
  }
  constructor(
    private db: Database,
    private workspaces: WorkspaceService,
    registerSecret?: (value: string) => void,
  ) {
    this.environment = new CapabilityEnvironment(db, registerSecret);
    db.run(
      "UPDATE capability_runs SET status='interrupted',error='The server restarted during execution.' WHERE status='running'",
    );
    db.run("UPDATE capability_jobs SET status='pending' WHERE status='running'");
  }
  setWake(callback: NonNullable<CapabilityService['wake']>) {
    this.wake = callback;
  }
  start() {
    this.timer = setInterval(() => {
      this.queueRun ??= this.drain()
        .catch(() => {})
        .finally(() => {
          this.queueRun = undefined;
        });
    }, 500);
    this.timer.unref();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
    await Promise.allSettled([...this.pending]);
    await this.queueRun;
  }
  private file(version: string) {
    return join(this.db.dir, 'capabilities', version, 'module.cjs');
  }
  private record(row: Row): CapabilityRegistration {
    const definition = JSON.parse(String(row.definition_json)) as CapabilityDefinition;
    const configured = this.environment.resolve(String(row.workspace_id), definition.requiredEnv);
    const missingEnv = definition.requiredEnv.filter((name) => !configured[name]);
    const enabled = Boolean(row.enabled);
    const error =
      this.failures.get(String(row.id)) ||
      (!existsSync(this.file(String(row.version)))
        ? 'Saved module is missing. Update the registration to recover.'
        : null);
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerBotId: row.owner_bot_id as string | null,
      kind: row.kind as 'tool' | 'route',
      modulePath: String(row.module_path),
      exportName: String(row.export_name),
      version: String(row.version),
      enabled,
      definition,
      missingEnv,
      error,
      status: !enabled
        ? 'disabled'
        : error
          ? 'invalid'
          : missingEnv.length
            ? 'needs_configuration'
            : 'ready',
      ...(definition.path
        ? {
            url:
              (process.env.MUKAI_PUBLIC_BASE_URL || this.localBaseUrl).replace(/\/$/, '') +
              definition.path,
          }
        : {}),
    };
  }
  list(workspaceId: string) {
    this.workspaces.require(workspaceId);
    return this.db
      .all('SELECT * FROM capabilities WHERE workspace_id=? ORDER BY kind,name', workspaceId)
      .map((row) => this.record(row));
  }
  private require(id: string, workspaceId?: string) {
    const row = this.db.get('SELECT * FROM capabilities WHERE id=?', id);
    if (!row || (workspaceId && row.workspace_id !== workspaceId))
      throw new ApiError(404, 'Capability not found.');
    return this.record(row);
  }
  detail(id: string, workspaceId: string) {
    const registration = this.require(id, workspaceId);
    const sourcePath = join(this.db.dir, 'capabilities', registration.version, 'source.txt');
    const source = existsSync(sourcePath)
      ? readFileSync(sourcePath, 'utf8')
      : 'Saved source is missing. Update from the workspace file to recover.';
    const runs = this.db
      .all(
        'SELECT * FROM capability_runs WHERE capability_id=? ORDER BY started_at DESC LIMIT 30',
        id,
      )
      .map(
        (row) =>
          ({
            id: String(row.id),
            version: String(row.version),
            status: String(row.status),
            startedAt: String(row.started_at),
            durationMs: row.duration_ms as number | null,
            error: row.error as string | null,
          }) satisfies CapabilityRun,
      );
    const jobs = this.db.all(
      'SELECT id,status,attempts,error FROM capability_jobs WHERE capability_id=? ORDER BY rowid DESC LIMIT 30',
      id,
    );
    return { registration, source: this.environment.redact(source), runs, jobs };
  }
  async initialize() {
    for (const row of this.db.all('SELECT * FROM capabilities WHERE enabled=1')) {
      try {
        const registration = this.record(row);
        const definition = await this.validate(
          registration.version,
          registration.exportName,
          registration.kind,
        );
        this.versions.set(registration.version, definition);
      } catch (error) {
        this.failures.set(String(row.id), this.error(error));
      }
    }
  }
  private error(error: unknown) {
    return this.environment
      .redact(error instanceof Error ? error.message : String(error))
      .slice(0, 2000);
  }
  private async validate(
    version: string,
    exportName: string,
    kind: 'tool' | 'route',
    signal?: AbortSignal,
  ) {
    const value = await this.worker(
      { file: this.file(version), exportName, kind, operation: 'validate', env: {} },
      5000,
      signal,
    );
    const definition = definitionSchema.parse(value);
    if (reserved.has(definition.name))
      throw new ApiError(409, 'This name belongs to a built-in capability.');
    if (kind === 'tool') {
      if (
        !definition.description ||
        !definition.inputSchema ||
        definition.inputSchema.type !== 'object'
      )
        throw new ApiError(400, 'Tools require a description and an object inputSchema.');
      this.ajv.compile(definition.inputSchema);
    } else if (
      !definition.method ||
      !definition.path ||
      !definition.auth ||
      !/^\/custom\/[A-Za-z0-9_/-]+$/.test(definition.path) ||
      definition.path.includes('//') ||
      definition.path.endsWith('/')
    ) {
      throw new ApiError(
        400,
        'Routes require method, auth, and an exact /custom/... pathname without a trailing slash.',
      );
    }
    return definition;
  }
  async manage(
    workspaceId: string,
    ownerBotId: string | null,
    kind: 'tool' | 'route',
    value: z.input<typeof registrationInput>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const input = registrationInput.parse(value);
    if (input.operation === 'list')
      return this.list(workspaceId).filter((item) => item.kind === kind);
    const previous = input.id ? this.require(input.id, workspaceId) : undefined;
    if (previous && (previous.kind !== kind || (ownerBotId && previous.ownerBotId !== ownerBotId)))
      throw new ApiError(403, 'Only the owner may change this registration.');
    if (input.operation === 'inspect') {
      if (!previous) throw new ApiError(400, 'Choose a registration ID.');
      return this.detail(previous.id, workspaceId);
    }
    if (['enable', 'disable', 'remove'].includes(input.operation)) {
      if (!previous) throw new ApiError(400, 'Choose a registration ID.');
      if (input.operation === 'remove') {
        this.db.run('DELETE FROM capabilities WHERE id=?', previous.id);
        this.failures.delete(previous.id);
        return { removed: true };
      }
      if (input.operation === 'enable') {
        await this.validate(previous.version, previous.exportName, kind, signal);
        this.failures.delete(previous.id);
      }
      this.db.run(
        'UPDATE capabilities SET enabled=? WHERE id=?',
        input.operation === 'enable' ? 1 : 0,
        previous.id,
      );
      return this.require(previous.id);
    }
    if ((input.operation === 'update' && !previous) || (input.operation === 'register' && previous))
      throw new ApiError(400, 'Update requires an existing ID; register creates a new ID.');
    const workspace = this.workspaces.require(workspaceId);
    if (!workspace.folder) throw new ApiError(400, 'Connect a workspace folder first.');
    const modulePath = input.modulePath || previous?.modulePath;
    if (!modulePath || !['.ts', '.js', '.mjs', '.cjs'].includes(extname(modulePath)))
      throw new ApiError(400, 'Choose a .ts/.js module inside the workspace.');
    const files = new WorkspaceFileService(workspace.folder, this.db.dir);
    const entry = (await files.path(modulePath)).absolute;
    const version = randomUUID();
    const directory = join(this.db.dir, 'capabilities', version);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const source = readFileSync(entry, 'utf8');
    if (Buffer.byteLength(source) > 262144) throw new ApiError(400, 'Module exceeds 256 KB.');
    const sources: Record<string, string> = {};
    try {
      const compiled = await buildCapability({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        write: false,
        logLevel: 'silent',
        metafile: true,
        plugins: [
          {
            name: 'workspace-sources',
            setup: (api) => {
              api.onLoad({ filter: /.*/ }, async (args) => {
                const local = relative(workspace.folder!, args.path);
                if (isAbsolute(local) || local.split(/[\\/]/)[0] === '..')
                  throw new Error('Dependencies must be installed inside the workspace.');
                if (!local.split(/[\\/]/).includes('node_modules')) {
                  await files.path(local);
                  const text = readFileSync(args.path, 'utf8');
                  if (Buffer.byteLength(text) > 262144)
                    throw new Error('Source file exceeds 256 KB.');
                  sources[local] = text;
                }
                return undefined;
              });
            },
          },
        ],
      });
      const output = compiled.outputFiles?.[0]?.text;
      if (!output || Buffer.byteLength(output) > 10 * 1024 * 1024)
        throw new Error('Compiled module exceeds 10 MB.');
      writeFileSync(this.file(version), output, { mode: 0o600 });
      writeFileSync(join(directory, 'source.txt'), source, { mode: 0o600 });
      writeFileSync(join(directory, 'sources.json'), JSON.stringify(sources), { mode: 0o600 });
      const exportName = value.exportName || previous?.exportName || 'default';
      const definition = await this.validate(version, exportName, kind, signal);
      writeFileSync(
        join(directory, 'manifest.json'),
        JSON.stringify({ exportName, kind, definition }),
        { mode: 0o600 },
      );
      const id = previous?.id || randomUUID();
      // Check against the latest row after async staging to avoid overwriting another update.
      this.db.transaction(() => {
        signal?.throwIfAborted();
        if (previous && this.require(id).version !== previous.version)
          throw new ApiError(409, 'This registration changed while staging. Retry the update.');
        const conflict = this.db.get(
          'SELECT id FROM capabilities WHERE workspace_id=? AND kind=? AND name=? AND id!=?',
          workspaceId,
          kind,
          definition.name,
          id,
        );
        const routeConflict =
          kind === 'route' &&
          this.db.get(
            "SELECT id FROM capabilities WHERE kind='route' AND method=? AND path=? AND id!=?",
            definition.method!,
            definition.path!,
            id,
          );
        if (conflict || routeConflict)
          throw new ApiError(409, 'A capability already uses this name or method/path.');
        this.db.run(
          `INSERT INTO capabilities VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,module_path=excluded.module_path,export_name=excluded.export_name,version=excluded.version,definition_json=excluded.definition_json,method=excluded.method,path=excluded.path`,
          id,
          workspaceId,
          previous?.ownerBotId ?? ownerBotId,
          kind,
          definition.name,
          modulePath,
          exportName,
          version,
          previous ? Number(previous.enabled) : 1,
          JSON.stringify(definition),
          definition.method || null,
          definition.path || null,
        );
      });
      this.versions.set(version, definition);
      this.failures.delete(id);
      return this.require(id);
    } catch (error) {
      throw new ApiError(error instanceof ApiError ? error.status : 400, this.error(error));
    }
  }
  private worker(
    data: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    rpc?: (action: string, args: unknown[]) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.closing) return Promise.reject(new ApiError(503, 'Capability runtime is stopping.'));
    if (this.workers.size >= 8)
      return Promise.reject(new ApiError(429, 'Custom capability concurrency limit reached.'));
    const operation = new Promise<unknown>((resolve, reject) => {
      signal?.throwIfAborted();
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: data,
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      this.workers.add(worker);
      // Drain and discard stdout/stderr: arbitrary module logs may contain secrets.
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate().finally(() => this.workers.delete(worker));
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        worker.postMessage({ type: 'abort' });
        finish(new ApiError(499, 'Capability execution cancelled.'));
      };
      const timer = setTimeout(
        () =>
          finish(new ApiError(504, 'Capability execution timed out; its worker was terminated.')),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('error', (error) => finish(new ApiError(500, this.error(error))));
      worker.on('exit', () =>
        finish(new ApiError(500, 'Capability worker exited before completing.')),
      );
      worker.on(
        'message',
        (message: {
          type: string;
          value?: unknown;
          error?: string;
          id: number;
          action: string;
          args: unknown[];
        }) => {
          if (message.type === 'result') finish(undefined, message.value);
          else if (message.type === 'error')
            finish(
              new ApiError(400, this.environment.redact(message.error || 'Capability failed.')),
            );
          else if (message.type === 'rpc' && !settled) {
            Promise.resolve()
              .then(() =>
                rpc
                  ? rpc(message.action, message.args)
                  : Promise.reject(new Error('Helpers are unavailable during validation.')),
              )
              .then(
                (value) => {
                  if (!settled) worker.postMessage({ type: 'reply', id: message.id, value });
                },
                (error) => {
                  if (!settled)
                    worker.postMessage({ type: 'reply', id: message.id, error: this.error(error) });
                },
              );
          }
        },
      );
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  private enqueue(
    registration: CapabilityRegistration,
    provider: string,
    eventId: string,
    payload: unknown,
  ) {
    z.string().min(1).max(100).parse(provider);
    z.string().min(1).max(200).parse(eventId);
    const text = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(text) > 262144) throw new ApiError(413, 'Job payload exceeds 256 KB.');
    if (provider !== '__mukai_wake' && !registration.definition.hasJobHandler)
      throw new ApiError(400, 'Define processJob before enqueueing background work.');
    const id = randomUUID();
    this.db.run(
      "INSERT INTO capability_jobs VALUES(?,?,?,?,?,?,'pending',0,?,NULL) ON CONFLICT(capability_id,provider,event_id) DO NOTHING",
      id,
      registration.id,
      registration.version,
      provider,
      eventId,
      this.environment.encrypt(text),
      Date.now(),
    );
    const saved = this.db.get(
      'SELECT id FROM capability_jobs WHERE capability_id=? AND provider=? AND event_id=?',
      registration.id,
      provider,
      eventId,
    )!;
    return { id: String(saved.id), duplicate: saved.id !== id };
  }
  async invoke(
    id: string,
    input: unknown,
    operation?: 'execute' | 'handle' | 'processJob',
    signal?: AbortSignal,
    version?: string,
    jobId?: string,
  ) {
    const registration = this.require(id);
    if (registration.status !== 'ready')
      throw new ApiError(
        409,
        registration.status === 'needs_configuration'
          ? 'Needs configuration: ' + registration.missingEnv.join(', ')
          : registration.error || 'Capability is disabled.',
      );
    operation ||= registration.kind === 'tool' ? 'execute' : 'handle';
    const selectedVersion = version || registration.version;
    const manifest = JSON.parse(
      readFileSync(join(this.db.dir, 'capabilities', selectedVersion, 'manifest.json'), 'utf8'),
    ) as { exportName: string; definition: CapabilityDefinition };
    const definition =
      this.versions.get(selectedVersion) ||
      (selectedVersion === registration.version ? registration.definition : undefined);
    if (!definition) throw new ApiError(400, 'Job version could not be loaded.');
    if (operation === 'execute') {
      const validate = this.ajv.compile(definition.inputSchema!);
      if (!validate(input)) throw new ApiError(400, 'Tool arguments do not match inputSchema.');
    }
    const env = this.environment.resolve(registration.workspaceId, definition.requiredEnv);
    if (definition.requiredEnv.some((name) => !env[name]))
      throw new ApiError(409, 'Job version needs configuration.');
    const runId = randomUUID(),
      started = Date.now();
    let wakeSequence = 0;
    this.db.run(
      "INSERT INTO capability_runs VALUES(?,?,?,'running',?,NULL,NULL)",
      runId,
      id,
      selectedVersion,
      new Date().toISOString(),
    );
    try {
      const value = await this.worker(
        {
          file: this.file(selectedVersion),
          exportName: manifest.exportName,
          operation,
          env,
          input,
          workspaceId: registration.workspaceId,
        },
        definition.timeoutMs,
        signal,
        async (action, args) => {
          if (action === 'enqueue') {
            const [provider, eventId, payload] = args;
            if (provider === '__mukai_wake') throw new ApiError(403, 'Reserved provider name.');
            return this.enqueue(
              { ...registration, version: selectedVersion, definition },
              z.string().parse(provider),
              z.string().parse(eventId),
              payload,
            );
          }
          if (action === 'wakeBot') {
            if (!registration.ownerBotId || !this.wake)
              throw new ApiError(403, 'This registration has no owner bot to wake.');
            const message = z.string().min(1).max(8000).parse(args[0]);
            this.enqueue(
              registration,
              '__mukai_wake',
              jobId ? `${jobId}:${++wakeSequence}` : randomUUID(),
              {
                message,
                botId: registration.ownerBotId,
              },
            );
            return { accepted: true };
          }
          throw new ApiError(400, 'Unknown capability helper.');
        },
      );
      if (operation === 'handle') validateResponse(value);
      this.db.run(
        "UPDATE capability_runs SET status='complete',duration_ms=? WHERE id=?",
        Date.now() - started,
        runId,
      );
      // Preserve the HTTP envelope while filtering returned body/header data.
      if (operation === 'handle') {
        const response = validateResponse(value);
        return {
          status: response.status,
          headers: response.headers
            ? Object.fromEntries(
                Object.entries(response.headers).map(([name, value]) => [
                  name,
                  this.environment.redact(value),
                ]),
              )
            : undefined,
          body: this.environment.publicValue(response.body),
        };
      }
      return this.environment.publicValue(value);
    } catch (error) {
      this.db.run(
        'UPDATE capability_runs SET status=?,duration_ms=?,error=? WHERE id=?',
        signal?.aborted ? 'interrupted' : 'failed',
        Date.now() - started,
        this.error(error),
        runId,
      );
      throw new ApiError(error instanceof ApiError ? error.status : 500, this.error(error));
    }
  }
  private async drain() {
    if (this.closing) return;
    const job = this.db
      .all(
        `SELECT j.* FROM capability_jobs j JOIN capabilities c ON c.id=j.capability_id WHERE j.status='pending' AND j.next_at<=? AND c.enabled=1 ORDER BY j.rowid LIMIT 100`,
        Date.now(),
      )
      .find((row) => this.require(String(row.capability_id)).status === 'ready');
    if (!job) return;
    const registration = this.require(String(job.capability_id));
    if (registration.status !== 'ready') return;
    this.db.run(
      "UPDATE capability_jobs SET status='running',attempts=attempts+1 WHERE id=?",
      String(job.id),
    );
    try {
      if (job.provider === '__mukai_wake') {
        const payload = JSON.parse(this.environment.decrypt(String(job.payload), false)) as {
          message: string;
          botId: string;
        };
        if (!this.wake || payload.botId !== registration.ownerBotId)
          throw new Error('Owner bot is unavailable.');
        await this.wake(payload.botId, registration.workspaceId, payload.message, String(job.id));
      } else {
        if (!this.versions.has(String(job.version))) {
          const manifest = JSON.parse(
            readFileSync(
              join(this.db.dir, 'capabilities', String(job.version), 'manifest.json'),
              'utf8',
            ),
          ) as { exportName: string };
          this.versions.set(
            String(job.version),
            await this.validate(String(job.version), manifest.exportName, registration.kind),
          );
        }
        await this.invoke(
          registration.id,
          JSON.parse(this.environment.decrypt(String(job.payload), false)),
          'processJob',
          undefined,
          String(job.version),
          String(job.id),
        );
      }
      this.db.run(
        "UPDATE capability_jobs SET status='complete',payload='null',error=NULL WHERE id=?",
        String(job.id),
      );
    } catch (error) {
      this.db.run(
        'UPDATE capability_jobs SET status=?,next_at=?,error=? WHERE id=?',
        Number(job.attempts) >= 4 ? 'failed' : 'pending',
        Date.now() + Math.min(60000, 1000 * 2 ** Number(job.attempts)),
        this.error(error),
        String(job.id),
      );
    }
  }
  async dispatch(request: IncomingMessage, response: ServerResponse, token: string) {
    const url = new URL(request.url || '/', 'http://localhost');
    const row = this.db.get(
      "SELECT * FROM capabilities WHERE kind='route' AND method=? AND path=?",
      request.method || 'GET',
      url.pathname,
    );
    if (!row) throw new ApiError(404, 'Custom route not found.');
    const registration = this.record(row);
    const host = request.headers.host || '';
    const base = process.env.MUKAI_PUBLIC_BASE_URL;
    const publicHost = base ? new URL(base).host : null;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) && host !== publicHost)
      throw new ApiError(403, 'Custom route host is not configured.');
    if (registration.definition.auth === 'mukai') {
      const given = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
      const expected = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw new ApiError(401, 'API authentication required.');
      const origin = request.headers.origin;
      if (origin && origin !== 'null' && !/^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin))
        throw new ApiError(403, 'Untrusted request origin.');
    }
    const rawBody = await body(request, 1024 * 1024);
    let parsed: unknown;
    if (/^application\/json\b/i.test(request.headers['content-type'] || '') && rawBody.length) {
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        /* A signature verifier still receives the original bytes. */
      }
    }
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', abort);
    let result: CustomResponse;
    try {
      result = validateResponse(
        await this.invoke(
          registration.id,
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            rawBody,
            body: parsed,
          },
          'handle',
          controller.signal,
        ),
      );
    } finally {
      response.off('close', abort);
    }
    for (const [name, value] of Object.entries(result.headers || {})) {
      response.setHeader(name, value);
    }
    if (!Object.keys(result.headers || {}).some((name) => name.toLowerCase() === 'content-type'))
      response.setHeader(
        'Content-Type',
        typeof result.body === 'string'
          ? 'text/plain; charset=utf-8'
          : 'application/json; charset=utf-8',
      );
    response.writeHead(result.status);
    response.end(
      request.method === 'HEAD' || [204, 304].includes(result.status)
        ? undefined
        : typeof result.body === 'string'
          ? result.body
          : JSON.stringify(result.body ?? null),
    );
  }
  forBot(bot: Bot, signal: AbortSignal, onActivity: (activity: ChatActivity) => void): ToolSet {
    const tools: ToolSet = {};
    for (const kind of ['tool', 'route'] as const)
      tools['register_custom_' + kind] = tool({
        description: `Manage custom ${kind} modules saved as .ts/.js files in this workspace. Use operation register/update after writing or editing a file. Modules export default objects. Tools: {name,description,inputSchema (JSON Schema object),requiredEnv:[],execute(args,context)}. Routes: {name,method,path:'/custom/...',auth:'mukai'|'handler'|'public',requiredEnv:[],handle(request,context),processJob?(payload,context)}. Read declared secrets only through context.env; never hard-code credentials or open a listener. Use context.signal with fetch. Return serializable results; routes return {status,headers?,body?}. Verify provider signatures against request.rawBody before work/enqueue. context.enqueue(provider,eventId,payload) durably deduplicates and queues processJob; context.wakeBot(message) explicitly queues a wake-up of the owner bot. Install dependencies in the workspace package setup before registration. Validation imports the module but never calls its handler; keep top-level code free of side effects. Code runs as trusted Node code with OS access. Names/configuration status are available; secret values are never available to you. Updates preserve the previous version on validation failure.`,
        inputSchema: registrationInput,
        execute: async (input, options) => {
          const activity: ChatActivity = {
            id: options.toolCallId,
            tool: 'register_custom_' + kind,
            action: input.operation,
            path: input.modulePath || input.id || '',
            status: 'running',
            summary: 'Managing custom capability',
          };
          onActivity(activity);
          try {
            const result = await this.manage(bot.workspaceId, bot.id, kind, input, signal);
            onActivity({
              ...activity,
              status: 'complete',
              summary: 'Custom capability ' + input.operation + ' completed.',
            });
            return result;
          } catch (error) {
            onActivity({ ...activity, status: 'failed', summary: this.error(error) });
            throw error;
          }
        },
      });
    for (const registration of this.list(bot.workspaceId).filter(
      (item) => item.kind === 'tool' && item.status === 'ready',
    )) {
      tools[registration.definition.name] = tool({
        description: this.environment.redact(registration.definition.description!),
        inputSchema: jsonSchema(registration.definition.inputSchema!),
        execute: async (input, options) => {
          const activity: ChatActivity = {
            id: options.toolCallId,
            tool: registration.definition.name,
            action: 'execute',
            path: registration.modulePath,
            status: 'running',
            summary: 'Running custom tool',
          };
          onActivity(activity);
          try {
            const result = await this.invoke(registration.id, input, 'execute', signal);
            onActivity({ ...activity, status: 'complete', summary: 'Custom tool completed.' });
            return result;
          } catch (error) {
            onActivity({
              ...activity,
              status: signal.aborted ? 'interrupted' : 'failed',
              summary: this.error(error),
            });
            throw error;
          }
        },
      });
    }
    return tools;
  }
}
