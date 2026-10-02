import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFileService } from './workspaceFileService';

let dir: string, root: string, privateDir: string, service: WorkspaceFileService;
const signal = () => new AbortController().signal;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-files-'));
  root = join(dir, 'project');
  privateDir = join(root, 'private-data');
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, 'secret.txt'), 'Private data');
  service = new WorkspaceFileService(root, privateDir);
});
afterEach(() => {
  expect(dir.startsWith(join(tmpdir(), 'mukai-files-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
describe('Workspace file boundaries and operations', () => {
  it('creates, reads, searches, and patches readable files, without overwriting by default', async () => {
    await service.execute({ action: 'create_directory', path: 'drafts' }, signal());
    await service.execute(
      { action: 'write_file', path: 'drafts/note.txt', content: 'First line\nUseful note' },
      signal(),
    );
    await expect(
      service.execute(
        { action: 'write_file', path: 'drafts/note.txt', content: 'Replacement' },
        signal(),
      ),
    ).rejects.toThrow('already exists');
    const read = await service.execute(
      { action: 'read_file', path: 'drafts/note.txt', startLine: 2 },
      signal(),
    );
    expect(read).toMatchObject({ content: 'Useful note', startLine: 2 });
    await service.execute(
      { action: 'patch', path: 'drafts/note.txt', oldText: 'Useful', newText: 'Better' },
      signal(),
    );
    expect(
      await service.execute({ action: 'search_files', path: 'drafts', query: 'better' }, signal()),
    ).toMatchObject({ matches: [{ path: 'drafts/note.txt', line: 2, text: 'Better note' }] });
    expect(readdirSync(join(root, 'drafts')).some((name) => name.startsWith('.mukai-write'))).toBe(
      false,
    );
  });
  it('rejects traversal, absolute paths, device/ADS paths, secrets, and private data', async () => {
    for (const path of [
      '../outside.txt',
      'C:/outside.txt',
      '/outside.txt',
      'note.txt:stream',
      'CON',
      'note. ',
      '.env',
      '.envrc',
      '.git/config',
      'credentials.key',
      'private-data/secret.txt',
    ]) {
      await expect(
        service.execute({ action: 'write_file', path, content: 'Do not write' }, signal()),
      ).rejects.toThrow();
    }
    expect(readFileSync(join(privateDir, 'secret.txt'), 'utf8')).toBe('Private data');
    const listed = await service.execute({ action: 'list' }, signal());
    expect(JSON.stringify(listed)).not.toContain('private-data');
    expect(
      await service.execute({ action: 'search_files', query: 'Private data' }, signal()),
    ).toMatchObject({ matches: [] });
  });
  it('blocks junctions and hard links that could escape a folder', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'file.txt'), 'Outside content');
    symlinkSync(outside, join(root, 'linked'), 'junction');
    linkSync(join(outside, 'file.txt'), join(root, 'hard.txt'));
    await expect(
      service.execute({ action: 'read_file', path: 'linked/file.txt' }, signal()),
    ).rejects.toThrow('Links');
    await expect(
      service.execute(
        { action: 'write_file', path: 'linked/file.txt', content: 'Changed', overwrite: true },
        signal(),
      ),
    ).rejects.toThrow('Links');
    await expect(
      service.execute({ action: 'read_file', path: 'hard.txt' }, signal()),
    ).rejects.toThrow('Hard-linked');
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('Outside content');
  });
  it('refuses binary/large files and ambiguous patches, and serializes edits from multiple bots', async () => {
    writeFileSync(join(root, 'binary.txt'), Buffer.from([0, 255, 0]));
    writeFileSync(join(root, 'large.txt'), 'a'.repeat(300000));
    await expect(
      service.execute({ action: 'read_file', path: 'binary.txt' }, signal()),
    ).rejects.toThrow('UTF-8');
    await expect(
      service.execute({ action: 'read_file', path: 'large.txt' }, signal()),
    ).rejects.toThrow('256 KB');
    writeFileSync(join(root, 'repeat.txt'), 'same same');
    await expect(
      service.execute(
        { action: 'patch', path: 'repeat.txt', oldText: 'same', newText: 'new' },
        signal(),
      ),
    ).rejects.toThrow('exactly once');
    writeFileSync(join(root, 'shared.txt'), 'original');
    const secondBot = new WorkspaceFileService(root, privateDir);
    const results = await Promise.allSettled([
      service.execute(
        { action: 'patch', path: 'shared.txt', oldText: 'original', newText: 'first bot' },
        signal(),
      ),
      secondBot.execute(
        { action: 'patch', path: 'shared.txt', oldText: 'original', newText: 'second bot' },
        signal(),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe(
      ['first bot', 'second bot'][winner],
    );
  });
  it('does not modify a file after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.execute(
        { action: 'write_file', path: 'stopped.txt', content: 'No effect' },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(readdirSync(root)).not.toContain('stopped.txt');
  });
});
