import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeOwner } from '../../shared/runtime';
import { encodeFrame, type Computer, type ComputerMethod } from './protocol';

export class GuestWorker implements Computer {
  private child?: ChildProcess;
  private closed = false;
  private pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
  >();
  constructor(
    private script: string,
    private uid: number,
    private gid: number,
  ) {}
  private start() {
    if (this.closed) throw new Error('Guest worker is shutting down.');
    if (this.child) return this.child;
    const child = fork(this.script, [], {
      uid: this.uid,
      gid: this.gid,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/home/mukai',
        USER: 'mukai',
        LOGNAME: 'mukai',
        LANG: 'C.UTF-8',
        DISPLAY: ':0',
      },
    });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('message', (raw) => {
      try {
        encodeFrame(raw);
        const frame = z
          .object({
            id: z.string().uuid(),
            result: z.unknown().optional(),
            error: z.string().optional(),
          })
          .parse(raw);
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.cleanup();
        if (frame.error) pending.reject(new Error(frame.error));
        else pending.resolve(frame.result);
      } catch {
        child.kill();
      }
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(
          new Error(
            'Guest tools worker stopped. Session tracking was lost; previous commands may still be running. Retry to start a new worker, or stop/start the workspace VM to clear remaining processes.',
          ),
        );
      }
      this.pending.clear();
    };
    child.on('error', failed);
    child.on('exit', failed);
    return child;
  }
  async request(method: ComputerMethod, input: unknown, owner: RuntimeOwner, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.pending.size >= 32) throw new Error('Guest worker is busy.');
    const child = this.start();
    const id = randomUUID();
    const frame = { id, method, input, owner };
    encodeFrame(frame);
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        if (child.connected) child.send({ cancel: id });
        reject(new Error('Guest request interrupted.'));
      };
      const timer = setTimeout(abort, 45000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      child.send(frame, (error) => {
        if (error) {
          this.pending.delete(id);
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
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.kill();
    });
  }
}
