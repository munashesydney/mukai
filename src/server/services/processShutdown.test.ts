import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ProcessService } from './processService';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

it('finishes shutdown when the shell exits but inherited output pipes remain open', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mukai-process-shutdown-'));
  if (!folder.startsWith(join(tmpdir(), 'mukai-process-shutdown-')))
    throw new Error('Unexpected test folder');
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('exit', null);
      return true;
    }),
  });
  let closed = 0;
  for (const pipe of [child.stdin, child.stdout, child.stderr])
    pipe.once('close', () => {
      if (++closed === 3) child.emit('close', null);
    });
  vi.mocked(spawn)
    .mockReturnValueOnce(child as never)
    .mockImplementation(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => {
        child.emit('exit', null);
        killer.emit('close', 0);
      });
      return killer as never;
    });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    child.emit('exit', null);
    return true;
  });
  const service = new ProcessService();
  try {
    const owner = { workspaceId: 'workspace', botId: 'bot', conversationId: 'chat' };
    const result = await service.run(
      owner,
      folder,
      { command: 'test', background: true },
      new AbortController().signal,
    );
    await service.shutdown();
    expect([child.stdin, child.stdout, child.stderr].every((pipe) => pipe.destroyed)).toBe(true);
    expect(service.read(owner, result.id).status).toBe('killed');
  } finally {
    await service.shutdown();
    rmSync(folder, { recursive: true, force: true });
  }
});
