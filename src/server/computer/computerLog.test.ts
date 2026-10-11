import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerLog } from './computerLog';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it('serializes concurrent diagnostic writes and bounds retention to three files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-log-'));
  directories.push(directory);
  const log = new ComputerLog(join(directory, 'health.log'), 8);
  for (const value of ['1111', '2222', '3333', '4444', '5555', '6666', '7777']) log.append(value);
  await log.flush();
  expect(await readFile(log.path, 'utf8')).toBe('7777');
  expect(await readFile(log.path + '.1', 'utf8')).toBe('55556666');
  expect(await readFile(log.path + '.2', 'utf8')).toBe('33334444');
  expect((await readdir(directory)).length).toBe(3);
});
it('retains bursts of small console chunks instead of dropping after 64 writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-log-'));
  directories.push(directory);
  const log = new ComputerLog(join(directory, 'console.log'));
  for (let index = 0; index < 10000; index++) log.append(`${index},`);
  await log.flush();
  expect(await readFile(log.path, 'utf8')).toBe(
    Array.from({ length: 10000 }, (_, index) => `${index},`).join(''),
  );
  expect(log.droppedBytes).toBe(0);
});
