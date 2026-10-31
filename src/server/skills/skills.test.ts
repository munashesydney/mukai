import { defaultSkills } from '../../skills';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { validateBundle } from './bundle';
import { importGithub } from './github';
import { skillTools } from '../tools/skills/execute';
import type { Bot } from '../../shared/ai';

const bundle = (
  name = 'review-code',
  body = 'Read the diff, check behavior, and report actionable issues.',
) => ({
  files: [
    {
      path: 'SKILL.md',
      encoding: 'utf8' as const,
      content: `---\nname: ${name}\ndescription: Review code changes before merging.\n---\n\n${body}`,
    },
    {
      path: 'references/checklist.md',
      encoding: 'utf8' as const,
      content: 'Check error paths and scope boundaries.',
    },
  ],
});
let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
let dir = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (api) {
    await new Promise<void>((resolve) => api!.server.close(() => resolve()));
    api = undefined;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    dir = '';
  }
});
async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'mukai-skills-test-'));
  api = await startApiServer(0, {
    dataDir: join(dir, 'data'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  seedTestBot(api.store);
  // These cases exercise user-created catalogs, including their empty state.
  for (const skill of api.skills.list('default')) api.skills.remove('default', skill.id);
  return api;
}
async function request(path: string, method = 'GET', value?: unknown) {
  const result = await fetch(api!.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + api!.token, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: result.status, data: await result.json() };
}

describe('skill bundles', () => {
  it('parses multiline frontmatter and preserves binary assets', () => {
    const input = bundle();
    input.files[0].content =
      '---\nname: review-code\ndescription: |\n  Review code changes.\n  Check behavior.\nallowed-tools: [Read, Bash]\n---\nDo useful work.';
    const parsed = validateBundle({
      ...input,
      files: [
        ...input.files,
        {
          path: 'assets/icon.png',
          encoding: 'base64',
          content: Buffer.from([0, 255, 1]).toString('base64'),
        },
      ],
    });
    expect(parsed.description).toContain('Check behavior.');
    expect(parsed.requirements[0]).toContain('Read, Bash');
    expect(parsed.bundle.files).toHaveLength(3);
  });
  it.each([
    '../outside.md',
    '/absolute.md',
    'references\\escape.md',
    'references/../escape.md',
    'CON.txt',
    'trailing.',
    'x\0.md',
  ])('rejects unsafe file path %s', (path) =>
    expect(() =>
      validateBundle({
        ...bundle(),
        files: [...bundle().files, { path, encoding: 'utf8', content: 'x' }],
      }),
    ).toThrow('safe relative paths'),
  );
  it('rejects case-colliding files and malformed YAML', () => {
    expect(() =>
      validateBundle({
        ...bundle(),
        files: [...bundle().files, { path: 'skill.md', encoding: 'utf8', content: 'x' }],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      validateBundle({
        files: [
          {
            path: 'SKILL.md',
            encoding: 'utf8',
            content: '---\nname: x\nname: y\ndescription: z\n---\nbody',
          },
        ],
      }),
    ).toThrow('YAML');
    expect(() =>
      validateBundle({ files: [{ path: 'SKILL.md', encoding: 'utf8', content: 'plain text' }] }),
    ).toThrow('frontmatter');
  });
  it('rejects oversized folders', () => {
    expect(() =>
      validateBundle({
        files: [
          ...bundle().files,
          { path: 'assets/large.txt', encoding: 'utf8', content: 'x'.repeat(8 * 1024 * 1024) },
        ],
      }),
    ).toThrow('8 MB');
  });
});

describe('workspace skills', () => {
  it.each([0, 3, 10, 13])(
    'previews the first 10 enabled skills with load references and counts the remainder for %i skills',
    async (count) => {
      const server = await setup();
      const names = Array.from(
        { length: count },
        (_, index) => 'workflow-' + String(index).padStart(2, '0'),
      );
      for (const name of [...names].reverse()) server.skills.save('default', bundle(name));
      const disabled = server.skills.save('default', bundle('disabled-workflow'));
      server.skills.enable('default', disabled.id, false);

      const context = server.skills.context('default', 'scout', 'bot-scout');
      if (!count) {
        expect(context).toBe('');
        return;
      }
      expect(JSON.parse(context.split('\n')[1])).toEqual(
        server.skills
          .list('default', '', false)
          .slice(0, 10)
          .map(({ id, name, description }) => ({ id, name, description })),
      );
      expect(context).toContain(`${Math.max(0, count - 10)} skills left.`);
      expect(context).toContain('operation search');
      expect(context).toContain('directly by ID or exact name');
      expect(context).not.toContain('disabled-workflow');
      expect(context).not.toContain('Read the diff, check behavior');
    },
  );

  it('ranks exact names first and finds partial keyword matches without requiring every term', async () => {
    const server = await setup();
    const reference = server.skills.save('default', bundle('mukai-api-reference'));
    server.skills.save('default', bundle('mukai-api-reference-extra'));
    server.skills.save('default', bundle('unrelated-workflow'));
    expect(server.skills.list('default', 'mukai-api-reference')[0].id).toBe(reference.id);
    expect(server.skills.list('default', 'mukai api reference custom routes bots')[0].id).toBe(
      reference.id,
    );
    expect(server.skills.list('default', 'mukai api').map((skill) => skill.name)).not.toContain(
      'unrelated-workflow',
    );
    expect(server.skills.list('default', 'nonexistent')).toEqual([]);
    server.skills.enable('default', reference.id, false);
    expect(server.skills.list('default', 'mukai', false).map((skill) => skill.id)).not.toContain(
      reference.id,
    );
  });

  it('loads exact names within the current workspace and returns canonical IDs', async () => {
    const server = await setup();
    const skill = server.skills.save('default', bundle());
    expect(server.skills.load('default', 'scout', 'bot-scout', skill.name)).toMatchObject({
      id: skill.id,
    });
    expect(() => server.skills.load('default', 'scout', 'bot-scout', 'review')).toThrow(
      'Skill not found',
    );
    const other = server.workspaces.create({ name: 'Other', folder: dir });
    const foreign = server.skills.save(other.id, bundle('foreign-workflow'));
    for (const reference of [foreign.id, foreign.name])
      expect(() => server.skills.load('default', 'scout', 'bot-scout', reference)).toThrow(
        'Skill not found',
      );
    server.skills.enable('default', skill.id, false);
    expect(() => server.skills.load('default', 'scout', 'bot-scout', skill.name)).toThrow('Enable');
  });

  it('creates, searches, updates with version checks, and isolates workspaces', async () => {
    const server = await setup();
    const created = await request('/skills', 'POST', bundle());
    expect(created.status).toBe(200);
    expect(created.data.fileCount).toBe(2);
    expect((await request('/skills?q=review')).data).toHaveLength(1);
    const w = await request('/workspaces', 'POST', {
      name: 'Other',
      description: '',
      folder: dir,
    });
    expect(w.status).toBe(201);
    expect((await request('/skills?workspaceId=' + w.data.id)).data).toHaveLength(
      defaultSkills.length,
    );
    expect((await request('/skills/' + created.data.id + '?workspaceId=' + w.data.id)).status).toBe(
      404,
    );
    expect((await request('/skills', 'POST', bundle())).status).toBe(409);
    const update = await request('/skills/' + created.data.id, 'PUT', {
      bundle: bundle('review-code', 'New workflow.'),
      expectedVersion: created.data.version,
    });
    expect(update.status).toBe(200);
    expect(update.data.version).not.toBe(created.data.version);
    expect(
      (
        await request('/skills/' + created.data.id, 'PUT', {
          bundle: bundle(),
          expectedVersion: created.data.version,
        })
      ).status,
    ).toBe(409);
    expect(server.skills.inspect('default', created.data.id).files[0]).toBeDefined();
  });
  it('accepts supporting files above the default HTTP body size and never executes scripts', async () => {
    await setup();
    const input = bundle();
    input.files.push({
      path: 'scripts/work.ts',
      encoding: 'utf8',
      content: 'throw new Error("MUST NOT EXECUTE");\n' + '// text\n'.repeat(12000),
    });
    const created = await request('/skills', 'POST', input);
    expect(created.status).toBe(200);
    expect(created.data.fileCount).toBe(3);
    expect(
      (
        await request('/skills/' + created.data.id, 'PUT', {
          bundle: input,
          expectedVersion: created.data.version,
        })
      ).status,
    ).toBe(200);
  });
  it('persists pinned loaded context across service restart and removes it when disabled', async () => {
    let server = await setup();
    const skill = server.skills.save('default', bundle());
    server.skills.load('default', 'scout', 'bot-scout', skill.id);
    const context = server.skills.context('default', 'scout', 'bot-scout');
    expect(context).toContain('Read the diff');
    const updated = server.skills.save(
      'default',
      bundle('review-code', 'Changed instructions.'),
      skill.id,
      skill.version,
    );
    expect(server.skills.context('default', 'scout', 'bot-scout')).toBe(context);
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    api = undefined;
    server = await startApiServer(0, {
      dataDir: join(dir, 'data'),
      memoryExtractor: async () => ({ facts: [] }),
    });
    api = server;
    expect(server.skills.context('default', 'scout', 'bot-scout')).toBe(context);
    server.skills.load('default', 'scout', 'bot-scout', skill.id);
    expect(server.skills.context('default', 'scout', 'bot-scout')).toContain(
      'Changed instructions.',
    );
    server.skills.enable('default', updated.id, false);
    expect(server.skills.context('default', 'scout', 'bot-scout')).not.toContain(
      'Loaded skill workflows',
    );
    expect(() => server.skills.load('default', 'scout', 'bot-scout', skill.id)).toThrow('Enable');
    server.skills.enable('default', skill.id, true);
    expect(server.skills.context('default', 'scout', 'bot-scout')).not.toContain(
      'Loaded skill workflows',
    );
  });
  it('enforces context budget, ownership and resource boundaries', async () => {
    const server = await setup();
    const skill = server.skills.save('default', bundle());
    expect(() => server.skills.load('default', 'other', 'bot-scout', skill.id)).toThrow(
      'another bot',
    );
    expect(() => server.skills.read('default', skill.id, '../outside')).toThrow('safe relative');
    expect(server.skills.read('default', skill.id, 'references/checklist.md').content).toContain(
      'scope',
    );
    const binary = server.skills.save('default', {
      files: [
        ...bundle('binary-workflow').files,
        {
          path: 'assets/image.png',
          encoding: 'base64',
          content: Buffer.from([0, 255, 1]).toString('base64'),
        },
      ],
    });
    expect(server.skills.read('default', binary.id, 'assets/image.png')).toMatchObject({
      encoding: 'base64',
      content: 'AP8B',
      nextOffset: null,
    });
    const small = server.skills.save('default', bundle('small-model-workflow', 'x'.repeat(1200)));
    expect(() => server.skills.load('default', 'scout', 'bot-scout', small.id, 1000)).toThrow(
      'context budget',
    );
    const huge = server.skills.save('default', bundle('huge-workflow', 'x'.repeat(24001)));
    expect(() => server.skills.load('default', 'scout', 'bot-scout', huge.id)).toThrow(
      'context budget',
    );
    server.skills.load('default', 'scout', 'bot-scout', skill.id);
    server.skills.remove('default', skill.id);
    expect(server.skills.context('default', 'scout', 'bot-scout')).not.toContain(
      'Loaded skill workflows',
    );
  });
  it('exposes skills as one tool family and loads through runtime tools', async () => {
    const server = await setup();
    const skill = server.skills.save('default', bundle());
    const bot = { id: 'scout', workspaceId: 'default' } as Bot;
    const tools = skillTools({
      bot,
      conversationId: 'bot-scout',
      skills: server.skills,
      signal: new AbortController().signal,
      onActivity: () => {},
    });
    const result = await tools.skills.execute!(
      { operation: 'load', id: skill.id },
      { toolCallId: 'test-load', messages: [], context: {} },
    );
    expect(result).toMatchObject({ ok: true });
    const loadByName = await tools.skills.execute!(
      { operation: 'load', name: skill.name },
      { toolCallId: 'test-load-name', messages: [], context: {} },
    );
    expect(loadByName).toMatchObject({ ok: true });
    const missingReference = await tools.skills.execute!(
      { operation: 'load' },
      { toolCallId: 'test-load-missing', messages: [], context: {} },
    );
    expect(missingReference).toMatchObject({ ok: false });
    expect(JSON.stringify(missingReference)).toContain('Load requires id or exact name');
    expect(server.skills.context('default', 'scout', 'bot-scout')).toContain(skill.name);
    expect(
      (await request('/tools')).data.find((tool: { id: string }) => tool.id === 'skills'),
    ).toMatchObject({ name: 'Skills', available: true });
  });
  it('requires API authentication', async () => {
    await setup();
    expect((await fetch(api!.url + '/skills')).status).toBe(401);
  });
});

const commit = 'a'.repeat(40);
function fixture(mode = 'normal') {
  const input = bundle();
  const folder = 'skills/review';
  const blobs = input.files.map((file) => {
    const bytes = Buffer.from(file.content);
    return {
      path: folder + '/' + file.path,
      mode: '100644',
      type: 'blob',
      size: bytes.length,
      sha: createHash('sha1')
        .update('blob ' + bytes.length + '\0')
        .update(bytes)
        .digest('hex'),
      bytes,
    };
  });
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes('/commits/'))
      return new Response(
        JSON.stringify(path.endsWith('/commits/main') ? { sha: commit } : { message: 'not found' }),
        { status: path.endsWith('/commits/main') ? 200 : 404 },
      );
    if (path.includes('/git/trees/') && !path.includes('?recursive=1'))
      return new Response(
        JSON.stringify({
          tree: [
            { path: 'skills', type: 'tree', sha: 'b'.repeat(40) },
            { path: 'review', type: 'tree', sha: 'c'.repeat(40) },
          ],
        }),
      );
    if (path.includes('/git/trees/'))
      return new Response(
        JSON.stringify({
          truncated: mode === 'truncated',
          tree: blobs.map((blob) => ({
            ...blob,
            path: blob.path.slice(folder.length + 1),
            bytes: undefined,
            mode: mode === 'symlink' ? '120000' : blob.mode,
          })),
        }),
      );
    const blob = blobs.find((blob) => path.endsWith(blob.sha));
    if (!blob) return new Response('{}', { status: 404 });
    return new Response(
      JSON.stringify({
        encoding: 'base64',
        content: (mode === 'corrupt' ? Buffer.from('bad') : blob.bytes).toString('base64'),
      }),
    );
  });
  return fetcher as unknown as typeof fetch;
}
describe('GitHub imports', () => {
  it('imports the complete containing folder, pins commit, and excludes query parameters', async () => {
    const fetcher = fixture();
    const result = await importGithub(
      'https://github.com/org/repo/blob/main/skills/review/SKILL.md?plain=1',
      undefined,
      fetcher,
    );
    expect(result.files).toHaveLength(2);
    expect(result.source).toMatchObject({ commit, folder: 'skills/review' });
    expect(
      vi
        .mocked(fetcher)
        .mock.calls.every(([url]) =>
          String(url).startsWith('https://api.github.com/repos/org/repo/'),
        ),
    ).toBe(true);
  });
  it('accepts raw and folder URLs', async () => {
    expect(
      (
        await importGithub(
          'https://raw.githubusercontent.com/org/repo/main/skills/review/SKILL.md',
          undefined,
          fixture(),
        )
      ).files,
    ).toHaveLength(2);
    expect(
      (
        await importGithub(
          'https://github.com/org/repo/tree/main/skills/review',
          undefined,
          fixture(),
        )
      ).files,
    ).toHaveLength(2);
  });
  it.each([
    'http://github.com/org/repo/blob/main/x/SKILL.md',
    'https://localhost/private',
    'https://github.com.evil.test/org/repo/blob/main/x/SKILL.md',
    'https://user:secret@github.com/org/repo/blob/main/x/SKILL.md',
  ])('rejects nonpublic fetch targets %s', async (url) => {
    const fetcher = fixture();
    await expect(importGithub(url, undefined, fetcher)).rejects.toThrow('HTTPS GitHub');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['symlink', 'truncated', 'corrupt'])(
    'rejects unsafe or incomplete folders (%s)',
    async (mode) => {
      await expect(
        importGithub(
          'https://github.com/org/repo/blob/main/skills/review/SKILL.md',
          undefined,
          fixture(mode),
        ),
      ).rejects.toThrow();
    },
  );
});
