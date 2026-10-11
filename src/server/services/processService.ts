import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProcessSession, RuntimeOwner } from '../../shared/runtime';
import { ApiError } from '../config';

interface ManagedProcess {
  info: ProcessSession;
  child: ChildProcessWithoutNullStreams;
  output: string;
  offset: number;
  done: Promise<void>;
  exited: Promise<void>;
  timer: NodeJS.Timeout;
  stopping?: Promise<void>;
}
const OUTPUT_LIMIT = 64000;
function sameOwner(a: RuntimeOwner, b: RuntimeOwner) {
  return (
    a.workspaceId === b.workspaceId && a.botId === b.botId && a.conversationId === b.conversationId
  );
}

export class ProcessService {
  private sessions = new Map<string, ManagedProcess>();
  private closed = false;
  private deletingWorkspaces = new Set<string>();
  list(owner: RuntimeOwner) {
    return [...this.sessions.values()]
      .filter((entry) => sameOwner(entry.info, owner))
      .map((entry) => entry.info);
  }
  private require(owner: RuntimeOwner, id: string) {
    const entry = this.sessions.get(id);
    if (!entry || !sameOwner(entry.info, owner))
      throw new ApiError(404, 'Process not found in this conversation.');
    return entry;
  }
  read(owner: RuntimeOwner, id: string, from = 0) {
    const entry = this.require(owner, id);
    return {
      ...entry.info,
      output: entry.output.slice(Math.max(0, from - entry.offset)),
      nextOffset: entry.offset + entry.output.length,
      truncated: from < entry.offset,
    };
  }
  async wait(owner: RuntimeOwner, id: string, milliseconds: number, signal: AbortSignal) {
    const entry = this.require(owner, id);
    await this.awaitCompletion(entry, milliseconds, signal);
    return this.read(owner, id);
  }
  write(owner: RuntimeOwner, id: string, text: string) {
    const entry = this.require(owner, id);
    if (entry.info.status !== 'running' || entry.child.stdin.destroyed)
      throw new ApiError(400, 'Process is no longer accepting input.');
    entry.child.stdin.write(text);
    return { ...entry.info, summary: 'Input sent to process.' };
  }
  async kill(owner: RuntimeOwner, id: string) {
    const entry = this.require(owner, id);
    await this.stop(entry);
    return this.read(owner, id);
  }
  async run(
    owner: RuntimeOwner,
    folder: string,
    input: {
      command: string;
      cwd?: string;
      background?: boolean;
      timeoutSeconds?: number;
      yieldMs?: number;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.deletingWorkspaces.has(owner.workspaceId))
      throw new ApiError(409, 'Workspace is being deleted.');
    if (this.closed) throw new ApiError(503, 'Terminal is shutting down.');
    const root = await realpath(folder),
      cwd = await realpath(resolve(root, input.cwd || '.'));
    const path = relative(root, cwd);
    signal.throwIfAborted();
    if (this.deletingWorkspaces.has(owner.workspaceId))
      throw new ApiError(409, 'Workspace is being deleted.');
    if (this.closed) throw new ApiError(503, 'Terminal is shutting down.');
    if (
      isAbsolute(path) ||
      path === '..' ||
      path.startsWith('..' + sep) ||
      !(await stat(cwd)).isDirectory()
    )
      throw new ApiError(400, 'Choose a working directory within the workspace folder.');
    if ([...this.sessions.values()].filter((entry) => entry.info.status === 'running').length >= 16)
      throw new ApiError(429, 'Too many running processes. Stop a process first.');
    // Completed sessions are retained for inspection, with a bounded lifetime cache.
    if (this.sessions.size >= 100) {
      for (const [id, entry] of this.sessions) {
        if (entry.info.status !== 'running') this.sessions.delete(id);
        if (this.sessions.size < 80) break;
      }
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|MUKAI_DATA_DIR)/i.test(key),
      ),
    );
    if (this.deletingWorkspaces.has(owner.workspaceId))
      throw new ApiError(409, 'Workspace is being deleted.');
    const child =
      process.platform === 'win32'
        ? spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', input.command],
            { cwd, env, windowsHide: true },
          )
        : spawn('/bin/sh', ['-c', input.command], { cwd, env, detached: true });
    let finish!: () => void;
    let exited!: () => void;
    const entry: ManagedProcess = {
      info: {
        ...owner,
        id: randomUUID(),
        command: input.command,
        cwd,
        pid: child.pid || null,
        status: 'running',
        exitCode: null,
        createdAt: new Date().toISOString(),
      },
      child,
      output: '',
      offset: 0,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      exited: new Promise<void>((resolve) => {
        exited = resolve;
      }),
      timer: setTimeout(
        () => {
          void this.stop(entry);
        },
        (input.timeoutSeconds ?? (input.background ? 3600 : 300)) * 1000,
      ),
    };
    entry.timer.unref();
    const append = (chunk: string) => {
      entry.output += chunk;
      if (entry.output.length > OUTPUT_LIMIT) {
        const removed = entry.output.length - OUTPUT_LIMIT;
        entry.output = entry.output.slice(removed);
        entry.offset += removed;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', (error) => append('\nProcess input failed: ' + error.message));
    child.on('error', (error) => {
      entry.info.status = 'failed';
      append(error.message);
      clearTimeout(entry.timer);
      exited();
      finish();
    });
    child.on('exit', (code) => {
      entry.info.exitCode = code;
      exited();
    });
    child.on('close', (code) => {
      if (entry.info.status === 'running') entry.info.status = 'exited';
      entry.info.exitCode = code;
      clearTimeout(entry.timer);
      finish();
    });
    this.sessions.set(entry.info.id, entry);
    const abort = () => {
      void this.stop(entry);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (!input.background) await this.awaitCompletion(entry, input.yieldMs ?? 1000, signal);
      signal.throwIfAborted();
      return this.read(owner, entry.info.id);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private async awaitCompletion(entry: ManagedProcess, milliseconds: number, signal: AbortSignal) {
    signal.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let abort!: () => void;
    try {
      await Promise.race([
        entry.done,
        new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, milliseconds);
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
  }
  private stop(entry: ManagedProcess) {
    return (entry.stopping ??= (async () => {
      if (entry.info.status !== 'running') return;
      entry.info.status = 'killed';
      clearTimeout(entry.timer);
      const pid = entry.child.pid;
      if (pid) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve) => {
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
            });
            killer.on('close', (code) => {
              if (code !== 0) entry.child.kill();
              resolve();
            });
            killer.on('error', () => {
              entry.child.kill();
              resolve();
            });
          });
        } else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            entry.child.kill('SIGKILL');
          }
        }
      }
      await entry.exited;
      // Descendants can inherit shell pipes. After tree termination, release our
      // pipe handles instead of waiting indefinitely for every inherited writer.
      entry.child.stdin.destroy();
      entry.child.stdout.destroy();
      entry.child.stderr.destroy();
      await entry.done;
    })());
  }
  async stopWorkspace(id: string) {
    this.deletingWorkspaces.add(id);
    for (const [key, entry] of this.sessions) {
      if (entry.info.workspaceId !== id) continue;
      await this.stop(entry);
      this.sessions.delete(key);
    }
  }
  async shutdown() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((entry) => this.stop(entry)));
  }
}
