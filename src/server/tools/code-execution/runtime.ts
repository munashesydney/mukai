import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { codeWorkerSource } from './worker';
import { utf8Prefix } from '../../services/toolResultPolicy';

export interface CodeExecutionResult {
  ok: boolean;
  status: 'success' | 'error' | 'timeout' | 'interrupted';
  output: string;
  error?: string;
  toolCalls: number;
  durationMs: number;
}
export interface CodeToolBridge {
  names(): string[];
  call(name: string, input: unknown, callId: string, signal: AbortSignal): Promise<unknown>;
}

export const MAX_CODE_OUTPUT_BYTES = 96000;
const MAX_TOOL_CALLS = 50;

export class CodeExecutionRuntime {
  private active = 0;

  async run(
    code: string,
    timeoutMs: number,
    callId: string,
    signal: AbortSignal,
    bridge: CodeToolBridge,
    maxOutputBytes = MAX_CODE_OUTPUT_BYTES,
  ): Promise<CodeExecutionResult> {
    signal.throwIfAborted();
    if (this.active >= 8) throw new Error('Code execution concurrency limit reached.');
    this.active++;
    try {
      return await this.execute(code, timeoutMs, callId, signal, bridge, maxOutputBytes);
    } finally {
      this.active--;
    }
  }

  private execute(
    code: string,
    timeoutMs: number,
    callId: string,
    signal: AbortSignal,
    bridge: CodeToolBridge,
    maxOutputBytes: number,
  ): Promise<CodeExecutionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const names = bridge.names();
    const worker = new Worker(codeWorkerSource, {
      eval: true,
      workerData: {
        enginePath: createRequire(__filename).resolve('quickjs-emscripten'),
        tools: names,
        code,
        timeoutMs,
        outputBytes: maxOutputBytes,
        maxToolCalls: MAX_TOOL_CALLS,
      },
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    return new Promise((resolve) => {
      let settled = false,
        output = '',
        truncated = false,
        toolCalls = 0;
      let remaining = timeoutMs,
        clockStarted = Date.now();
      const pending = new Set<Promise<void>>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (status: CodeExecutionResult['status'], error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller.abort();
        const marker = truncated
          ? `\n\n[Printed output truncated to fit the ${maxOutputBytes}-byte budget.]`
          : '';
        // Never return while an internal host operation is still settling.
        void Promise.allSettled([worker.terminate(), ...pending]).then(() =>
          resolve({
            ok: status === 'success',
            status,
            ...(error ? { error } : {}),
            toolCalls,
            durationMs: Date.now() - started,
            output: utf8Prefix(output, maxOutputBytes - Buffer.byteLength(marker)) + marker,
          }),
        );
      };
      const resume = () => {
        if (timer || settled) return;
        clockStarted = Date.now();
        timer = setTimeout(
          () =>
            finish(
              'timeout',
              'Script computation timed out. Completed tool actions remain saved; verify activity before retrying.',
            ),
          Math.max(1, remaining),
        );
      };
      const pause = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = undefined;
        remaining -= Date.now() - clockStarted;
      };
      const abort = () =>
        finish(
          'interrupted',
          'Code execution interrupted. Verify completed and unresolved tool actions before retrying.',
        );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      resume();
      worker.on('error', (error) => finish('error', error.message.slice(0, 4000)));
      worker.on('exit', () => finish('error', 'Code execution worker exited before completing.'));
      worker.on(
        'message',
        (message: {
          type: string;
          status?: 'error' | 'timeout';
          text?: string;
          truncated?: boolean;
          error?: string;
          id: number;
          name: string;
          json: string;
        }) => {
          if (settled) return;
          if (message.type === 'busy') resume();
          else if (message.type === 'idle') pause();
          else if (message.type === 'output') {
            output += message.text || '';
            truncated ||= message.truncated === true;
          } else if (message.type === 'error') finish(message.status || 'error', message.error);
          else if (message.type === 'result') finish('success');
          else if (message.type === 'call') {
            const operation = Promise.resolve().then(async () => {
              try {
                if (++toolCalls > MAX_TOOL_CALLS)
                  throw new Error('Code execution tool-call limit reached.');
                if (!names.includes(message.name) || !bridge.names().includes(message.name))
                  throw new Error('Tool is unavailable inside code execution: ' + message.name);
                const input = JSON.parse(message.json);
                const value = await bridge.call(
                  message.name,
                  input,
                  callId + ':code:' + message.id,
                  combined,
                );
                combined.throwIfAborted();
                // Do not call toModelOutput or apply context truncation here.
                const json = JSON.stringify(value === undefined ? null : value);
                if (!settled) {
                  resume();
                  worker.postMessage({ type: 'reply', id: message.id, json });
                }
              } catch (error) {
                if (!settled) {
                  resume();
                  worker.postMessage({
                    type: 'reply',
                    id: message.id,
                    error: String(error instanceof Error ? error.message : error).slice(0, 4000),
                  });
                }
              }
            });
            pending.add(operation);
            void operation.finally(() => pending.delete(operation));
          }
        },
      );
    });
  }
}
