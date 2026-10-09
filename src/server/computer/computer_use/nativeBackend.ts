import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { DesktopBackend, DesktopCommand } from './protocol';

const FRAME_BYTES = 24 * 1024 * 1024;
export class NativeDesktopBackend implements DesktopBackend {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
  >();
  private nextId = 0;
  private closed = false;

  constructor(
    private helperDir = resolve('dist/computer_use'),
    private platform = process.platform,
  ) {}

  private command() {
    const name =
      this.platform === 'win32' ? 'windows.ps1' : this.platform === 'darwin' ? 'macos' : 'linux.py';
    let path = join(this.helperDir, name);
    if (!existsSync(path) && this.helperDir === resolve('dist/computer_use'))
      path = resolve('scripts/computer_use', name);
    if (!existsSync(path))
      throw new Error(`Computer use helper is missing (${name}). Run npm run build:computer-use.`);
    if (this.platform === 'win32')
      return {
        binary: join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path,
        ],
      };
    if (this.platform === 'darwin') return { binary: path, args: [] };
    if (this.platform === 'linux') return { binary: 'python3', args: ['-u', path] };
    throw new Error(`Computer use does not support ${this.platform}.`);
  }
  private start() {
    if (this.closed) throw new Error('Desktop backend is shutting down.');
    if (this.child) return this.child;
    const command = this.command();
    const child = spawn(command.binary, command.args, { stdio: 'pipe', windowsHide: true });
    this.child = child;
    let buffer = Buffer.alloc(0);
    let diagnostic = '';
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      child.stdin.destroy();
      child.kill();
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString('utf8')).slice(-2000);
    });
    child.stdout.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let end: number;
        while ((end = buffer.indexOf(10)) !== -1) {
          if (end > FRAME_BYTES) throw new Error('Desktop helper response exceeds its size limit.');
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          if (!line.length) continue;
          const response = z
            .object({
              id: z.number().int(),
              result: z.unknown().optional(),
              error: z.string().optional(),
            })
            .parse(JSON.parse(line.toString('utf8')));
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          pending.cleanup();
          if (response.error) pending.reject(new Error(response.error));
          else pending.resolve(response.result);
        }
        if (buffer.length > FRAME_BYTES)
          throw new Error('Desktop helper response exceeds its size limit.');
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid desktop helper response.'));
      }
    });
    child.on('error', (error) =>
      fail(new Error(`Desktop helper could not start: ${error.message}`)),
    );
    child.stdin.on('error', (error) =>
      fail(new Error(`Desktop helper input failed: ${error.message}`)),
    );
    child.stdout.on('error', (error) =>
      fail(new Error(`Desktop helper output failed: ${error.message}`)),
    );
    child.stderr.on('error', (error) =>
      fail(new Error(`Desktop helper diagnostics failed: ${error.message}`)),
    );
    child.on('close', () => fail(new Error('Desktop helper stopped. ' + diagnostic.trim())));
    // Timing out a primitive restarts the helper; the service releases its tracked inputs before reuse.
    return child;
  }
  async request(input: DesktopCommand, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const child = this.start();
    const id = ++this.nextId;
    const frame = Buffer.from(JSON.stringify({ id, ...input }) + '\n');
    if (frame.length > 100000) throw new Error('Desktop input exceeds its size limit.');
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(new Error('Desktop operation interrupted.'));
        // The service sends explicit releases behind the active primitive.
        // Do not kill the helper on caller cancellation, which could strand held input.
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        if (this.child === child) {
          this.child = undefined;
          child.kill();
        }
        for (const pending of this.pending.values()) {
          pending.cleanup();
          pending.reject(new Error('Desktop helper timed out.'));
        }
        this.pending.clear();
        reject(
          new Error('Desktop helper timed out. Check permissions and the interactive desktop.'),
        );
      }, 30000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      child.stdin.write(frame, (error) => {
        if (error && this.pending.delete(id)) {
          cleanup();
          reject(error);
        }
      });
    });
  }
  async shutdown() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
}
