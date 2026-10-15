import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DiagnosticPhase =
  | 'setup'
  | 'provider-request'
  | 'context-compaction'
  | 'memory-extraction'
  | 'tool-execution'
  | 'checkpoint'
  | 'response-save'
  | 'provider-test'
  | 'http-request'
  | 'computer';
export interface DiagnosticContext {
  workspaceId?: string;
  providerId?: string;
  providerKind?: string;
  model?: string;
  botId?: string;
  conversationId?: string;
  messageId?: string;
  tool?: string;
  phase?: DiagnosticPhase;
  step?: number;
  contextWindow?: number | null;
  usedTokens?: number;
  finishReason?: string;
  generatedTextBytes?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

// Sanitized diagnostics: never serialize SDK errors wholesale. They contain
// request bodies, authorization headers, tool arguments and generated source.
export class DiagnosticService {
  readonly path: string;
  private secrets = new Set<string>();
  constructor(
    private dir: string,
    private maxBytes = 2 * 1024 * 1024,
  ) {
    this.dir = join(dir, 'logs');
    this.path = join(this.dir, 'errors.log');
  }
  registerSecret(value: string | undefined) {
    if (value) this.secrets.add(value);
  }
  redactSecrets(value: string) {
    for (const secret of this.secrets) {
      // Public prose must not lose ordinary words used as local placeholder credentials.
      // Logs remain strictly redacted, including short values, in text() below.
      if (secret.length < 12) continue;
      value = value
        .split(secret)
        .join('[redacted]')
        .split(encodeURIComponent(secret))
        .join('[redacted]');
    }
    return value;
  }
  private text(value: unknown, limit = 2048): string | undefined {
    if (typeof value !== 'string') return undefined;
    let text = value.slice(0, 8192);
    for (const secret of this.secrets) {
      text = text.split(secret).join('[redacted]');
      text = text.split(encodeURIComponent(secret)).join('[redacted]');
    }
    text = text
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
      .replace(
        /((?:api[_-]?key|authorization|password|secret|access[_-]?token)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi,
        '$1[redacted]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/([?&](?:key|token|api[_-]?key|secret|signature)=)[^\s&#"']*/gi, '$1[redacted]')
      .replace(
        /\b(?:request body|requestBodyValues|prompt|tool arguments|tool input)\s*[:=][\s\S]*/gi,
        '[request content omitted]',
      )
      .replace(/\{[\s\S]*|\[\s*(?:[{"'\d]|$)[\s\S]*/, '[structured payload omitted]');
    return text.slice(0, limit);
  }
  private details(error: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown> {
    if (seen.has(error) || depth >= 4) return { name: 'CauseOmitted' };
    seen.add(error);
    if (!error || typeof error !== 'object')
      return {
        name: 'ThrownValue',
        message: this.text(typeof error === 'string' ? error : String(error)),
      };
    const item = error as Record<string, unknown>;
    const name = this.text(item.name, 128) || 'Error';
    const payloadError =
      /(?:ZodError|JSONParseError|TypeValidationError|InvalidArgumentError|InvalidToolInputError|InvalidResponseDataError)/.test(
        name,
      );
    const value: Record<string, unknown> = {
      name,
      message: payloadError
        ? 'Validation or parsing failed; raw payload omitted.'
        : this.text(item.message),
      code:
        typeof item.code === 'number' && Number.isFinite(item.code)
          ? item.code
          : this.text(item.code, 128),
      statusCode: typeof item.statusCode === 'number' ? item.statusCode : undefined,
      isRetryable: typeof item.isRetryable === 'boolean' ? item.isRetryable : undefined,
    };
    if (name === 'AI_NoObjectGeneratedError') {
      if (typeof item.text === 'string') value.generatedTextBytes = Buffer.byteLength(item.text);
      if (
        typeof item.finishReason === 'string' &&
        /^(stop|length|content-filter|tool-calls|error|other)$/.test(item.finishReason)
      )
        value.finishReason = item.finishReason;
    }
    if (typeof item.url === 'string') {
      try {
        const url = new URL(item.url);
        value.endpoint = this.text(url.origin + url.pathname, 512);
      } catch {
        /* Invalid URL is not useful diagnostic data. */
      }
    }
    if (typeof item.stack === 'string')
      value.stack = item.stack
        .slice(-16384)
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 16)
        .map((line) => this.text(line, 512));
    if (typeof item.responseBody === 'string') {
      value.responseBytes = Buffer.byteLength(item.responseBody);
      if (item.responseBody.length <= 65536) {
        try {
          const body = JSON.parse(item.responseBody);
          const response = body?.error && typeof body.error === 'object' ? body.error : body;
          if (response && typeof response === 'object')
            value.providerError = {
              type: this.text(response.type, 128),
              code:
                typeof response.code === 'number' && Number.isFinite(response.code)
                  ? response.code
                  : this.text(response.code, 128),
              message: this.text(response.message),
            };
        } catch {
          /* Never log an arbitrary HTML/plain-text response body. */
        }
      }
    }
    if (item.responseHeaders && typeof item.responseHeaders === 'object') {
      const headers = item.responseHeaders as Record<string, unknown>;
      value.providerRequestId = this.text(headers['x-request-id'] ?? headers['request-id'], 256);
      value.retryAfter = this.text(headers['retry-after'], 128);
    }
    if (item.cause !== undefined) value.cause = this.details(item.cause, seen, depth + 1);
    if (item.lastError !== undefined && item.lastError !== item.cause)
      value.lastError = this.details(item.lastError, seen, depth + 1);
    if (Array.isArray(item.errors))
      value.errors = item.errors.slice(-3).map((cause) => this.details(cause, seen, depth + 1));
    return value;
  }
  record(
    event: string,
    error: unknown,
    context: DiagnosticContext = {},
    level: 'error' | 'warn' = 'error',
    message?: string,
  ) {
    return this.write(event, context, level, error, message);
  }
  info(event: string, message: string, context: DiagnosticContext = {}) {
    return this.write(event, context, 'info', undefined, message);
  }
  private write(
    event: string,
    context: DiagnosticContext,
    level: 'error' | 'warn' | 'info',
    error: unknown,
    message?: string,
  ) {
    const id = randomUUID();
    try {
      const metadata: Record<string, unknown> = {};
      for (const key of [
        'workspaceId',
        'providerId',
        'providerKind',
        'model',
        'botId',
        'conversationId',
        'messageId',
        'tool',
        'phase',
        'finishReason',
      ] as const)
        if (context[key] !== undefined) metadata[key] = this.text(context[key], 512);
      for (const key of [
        'step',
        'contextWindow',
        'usedTokens',
        'generatedTextBytes',
        'outputTokens',
        'reasoningTokens',
      ] as const)
        if (typeof context[key] === 'number' && Number.isFinite(context[key]))
          metadata[key] = context[key];
      let details: Record<string, unknown> | undefined;
      if (level !== 'info') {
        try {
          details = this.details(error);
        } catch {
          details = {
            name: 'UninspectableError',
            message: 'Error properties could not be inspected safely.',
          };
        }
      }
      const line =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          id,
          level,
          event: this.text(event, 128),
          message: this.text(message),
          ...metadata,
          error: details,
        }) + '\n';
      console[level]('[mukai diagnostic] ' + line.trimEnd());
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        if (
          existsSync(this.path) &&
          statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
        ) {
          const oldest = join(this.dir, 'errors.2.log'),
            previous = join(this.dir, 'errors.1.log');
          if (existsSync(oldest)) unlinkSync(oldest);
          if (existsSync(previous)) renameSync(previous, oldest);
          renameSync(this.path, previous);
        }
        appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
      } catch (failure) {
        console.error('[mukai diagnostic] Could not save the log file', this.details(failure));
      }
    } catch {
      // Diagnostics must never interrupt a chat, including malicious error getters.
      console.error('[mukai diagnostic] Error details unavailable; diagnostic ID ' + id);
    }
    return id;
  }
}
