import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessService } from './processService';
const owner = { workspaceId: 'workspace', botId: 'scout', conversationId: 'chat' };
const signal = () => new AbortController().signal;
const command = (code: string) =>
  process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"; exit $LASTEXITCODE`
    : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${code.replaceAll("'", "'\\''")}'`;
let folder: string, service: ProcessService;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'mukai-process-'));
  service = new ProcessService();
});
afterEach(async () => {
  await service.shutdown();
  rmSync(folder, { recursive: true, force: true });
});
it('runs commands, captures output and exit codes, and isolates ownership', async () => {
  const run = await service.run(
    owner,
    folder,
    {
      command: command('console.log("hello"); console.error("stderr"); process.exitCode=7'),
      yieldMs: 30000,
    },
    signal(),
  );
  expect(run).toMatchObject({ status: 'exited', exitCode: 7, cwd: folder });
  expect(run.output).toContain('hello');
  expect(run.output).toContain('stderr');
  expect(() => service.read({ ...owner, conversationId: 'other' }, run.id)).toThrow('not found');
  expect(service.list({ ...owner, botId: 'other' })).toEqual([]);
});
it('manages background input, log offsets and process termination', async () => {
  const run = await service.run(
    owner,
    folder,
    {
      command: command(
        'process.stdin.on("data",x=>console.log("got:"+x)); console.log("ready"); setInterval(()=>{},1000)',
      ),
      background: true,
    },
    signal(),
  );
  expect(run.status).toBe('running');
  await service.wait(owner, run.id, 1200, signal());
  const log = service.read(owner, run.id);
  expect(log.output).toContain('ready');
  service.write(owner, run.id, 'input\n');
  await service.wait(owner, run.id, 300, signal());
  expect(service.read(owner, run.id, log.nextOffset).output).toContain('got:input');
  expect(await service.kill(owner, run.id)).toMatchObject({ status: 'killed' });
  expect(() => service.write(owner, run.id, 'bad')).toThrow('no longer');
});
it('bounds retained output and rejects working directories outside the workspace', async () => {
  const run = await service.run(
    owner,
    folder,
    { command: command('process.stdout.write("x".repeat(100000))'), yieldMs: 30000 },
    signal(),
  );
  expect(run.output.length).toBe(64000);
  expect(run.truncated).toBe(true);
  expect(run.nextOffset).toBe(100000);
  await expect(
    service.run(owner, folder, { command: 'echo wrong', cwd: '..' }, signal()),
  ).rejects.toThrow('within');
});
it('terminates an in-flight foreground command on cancellation and cleans background processes on shutdown', async () => {
  const controller = new AbortController();
  const pending = service.run(
    owner,
    folder,
    { command: command('setInterval(()=>{},1000)'), yieldMs: 30000 },
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 500);
  await expect(pending).rejects.toThrow();
  clearTimeout(timer);
  const background = await service.run(
    owner,
    folder,
    { command: command('setInterval(()=>{},1000)'), background: true },
    signal(),
  );
  await service.shutdown();
  expect(service.read(owner, background.id).status).toBe('killed');
  await expect(service.run(owner, folder, { command: 'echo no' }, signal())).rejects.toThrow(
    'shutting down',
  );
});
it('enforces a background process lifetime', async () => {
  const run = await service.run(
    owner,
    folder,
    { command: command('setInterval(()=>{},1000)'), background: true, timeoutSeconds: 1 },
    signal(),
  );
  await service.wait(owner, run.id, 3000, signal());
  expect(service.read(owner, run.id).status).toBe('killed');
});

it('stops only a deleted workspace process tree and rejects later starts', async () => {
  const other = { ...owner, workspaceId: 'other' };
  const input = { command: command('setInterval(()=>{},1000)'), background: true };
  await service.run(owner, folder, input, signal());
  const keep = await service.run(other, folder, input, signal());
  await service.stopWorkspace(owner.workspaceId);
  expect(service.list(owner)).toEqual([]);
  expect(service.read(other, keep.id).status).toBe('running');
  await expect(service.run(owner, folder, input, signal())).rejects.toThrow('being deleted');
  await service.kill(other, keep.id);
});

it('prevents a process still resolving its working directory from starting during deletion', async () => {
  const opening = service.run(
    owner,
    folder,
    { command: command('setInterval(()=>{},1000)'), background: true },
    signal(),
  );
  const failed = expect(opening).rejects.toThrow('being deleted');
  await service.stopWorkspace(owner.workspaceId);
  await failed;
  expect(service.list(owner)).toEqual([]);
});
