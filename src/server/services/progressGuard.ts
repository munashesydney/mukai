import { createHash } from 'node:crypto';

function hash(value: unknown) {
  // Detection must not recursively serialize an unbounded or circular raw result.
  let remaining = 128000,
    nodes = 8192;
  const seen = new Set<object>();
  const stable = (item: unknown, depth = 0): unknown => {
    if (--nodes < 0 || remaining <= 0 || depth >= 24) return '[Omitted]';
    if (typeof item === 'string') {
      const text = item.slice(0, Math.min(32768, remaining));
      remaining -= text.length;
      return text;
    }
    if (typeof item === 'bigint') return String(item);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.slice(0, 1024).map((part) => stable(part, depth + 1));
    else {
      const keys: string[] = [];
      for (const key in item) {
        if (keys.length >= 1024) break;
        if (
          Object.hasOwn(item, key) &&
          !['ref', 'timestamp', 'createdAt', 'updatedAt', 'note'].includes(key)
        )
          keys.push(key);
      }
      result = Object.fromEntries(
        keys
          .sort((a, b) => a.localeCompare(b))
          .map((key) => {
            remaining -= key.length;
            try {
              return [key, stable((item as Record<string, unknown>)[key], depth + 1)];
            } catch {
              return [key, '[Unreadable]'];
            }
          }),
      );
    }
    seen.delete(item);
    return result;
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export class ProgressGuard {
  private history: string[] = [];
  private refs = new Map<string, string>();
  private refScopes = new Map<string, Set<string>>();
  private states = new Map<string, string>();
  private strikes = 0;
  private warned = false;
  notice = '';
  paused = false;
  observe(name: string, input: unknown, output: unknown) {
    const args = (input || {}) as Record<string, unknown>;
    const envelope = (output || {}) as Record<string, unknown>;
    const result = (
      envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope
    ) as Record<string, unknown>;
    const action = String(args.action || name);
    // Polling is expected to return identical data while a process runs.
    // An unchanged poll alone is not evidence that the model is stuck.
    if (name === 'process' && ['poll', 'wait'].includes(action)) return;
    const scope = String(args.sessionId || args.id || '');
    if (name === 'browser' && action === 'snapshot') {
      for (const previous of this.refScopes.get(scope) || []) this.refs.delete(previous);
      const currentRefs = new Set<string>();
      for (const [index, control] of (
        (Array.isArray(result.controls) ? result.controls.slice(0, 1024) : []) as Record<
          string,
          unknown
        >[]
      ).entries()) {
        if (!control || typeof control !== 'object') continue;
        this.refs.set(
          String(control.ref),
          hash({ scope, url: result.url, role: control.role, name: control.name, index }),
        );
        currentRefs.add(String(control.ref));
      }
      this.refScopes.set(scope, currentRefs);
      const state = hash(result);
      if (this.states.get(scope) !== state) {
        this.states.set(scope, state);
        this.reset();
        return;
      }
    }
    if (name === 'browser' && action === 'close' && envelope.ok !== false) {
      for (const previous of this.refScopes.get(scope) || []) this.refs.delete(previous);
      this.refScopes.delete(scope);
      this.states.delete(scope);
    }
    const ref = args.ref ? this.refs.get(String(args.ref)) || 'unrecognized-control' : undefined;
    // A successful click/type/scroll can intentionally be repeated. Without a
    // confirming unchanged snapshot we cannot infer that the browser is stuck.
    if (
      name === 'browser' &&
      !['snapshot', 'get_text', 'tabs'].includes(action) &&
      !envelope.error &&
      envelope.ok !== false
    )
      return;
    const outcome =
      name === 'terminal'
        ? {
            output: result.output,
            status: result.status,
            exitCode: result.exitCode,
            cwd: result.cwd,
            error: result.error,
            ok: envelope.ok,
          }
        : result;
    const signature = hash({
      name,
      args: { ...args, ...(ref ? { target: ref } : {}) },
      result: outcome,
    });
    const repeated = this.history.includes(signature);
    this.history.push(signature);
    this.history = this.history.slice(-12);
    if (!repeated) {
      this.reset(false);
      return;
    }
    this.strikes++;
    if (this.strikes >= 4) {
      this.warned = true;
      this.notice =
        'Runtime detected repeated identical tool requests/results without evidence of progress. Reassess the approach, check the cause, and verify a meaningful state change. If repetition continues without progress, this run will pause. Do not merely change tool names to evade this check.';
    }
    if (this.warned && this.strikes >= 8) this.paused = true;
  }
  private reset(clearHistory = true) {
    this.strikes = 0;
    this.warned = false;
    this.notice = '';
    if (clearHistory) this.history = [];
  }
}
