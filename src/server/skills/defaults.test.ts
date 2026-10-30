import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../app';
import { seedTestBot } from '../testFixtures';
import { SkillService } from './service';
import { defaultSkills } from '../../skills';
import type { SkillBundle } from '../../shared/skills';

let root: string, api: Awaited<ReturnType<typeof startApiServer>>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mukai-default-skills-'));
  api = await startApiServer(0, { dataDir: join(root, 'data') });
  seedTestBot(api.store);
});
afterEach(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  api.dispose();
  await rm(root, { recursive: true, force: true });
});
const updated = (body: string): SkillBundle => ({
  files: [
    { ...defaultSkills[0].files[0], content: defaultSkills[0].files[0].content + '\n' + body },
  ],
});
it('discovers bundled skills through existing HTTP and bot search/load/read paths without loading the body by default', async () => {
  const response = await fetch(api.url + '/skills', {
    headers: { Authorization: 'Bearer ' + api.token },
  });
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(catalog).toHaveLength(1);
  const skill = catalog[0];
  expect(skill).toMatchObject({
    name: 'mukai-custom-routes-authenticated-websites',
    enabled: true,
    fileCount: 2,
  });
  expect(api.skills.list('default', 'authenticated dashboard')[0].id).toBe(skill.id);
  const context = api.skills.context('default', 'scout', 'bot-scout');
  expect(context).toContain('mukai-custom-routes-authenticated-websites');
  expect(context).not.toContain('/api/bots/');
  const loaded = api.skills.load('default', 'scout', 'bot-scout', skill.id);
  expect(loaded.instructions).toContain("auth:'session'");
  expect(loaded.instructions).toContain('POST /api/bots/{botId}/chat directly from the browser');
  expect(loaded.instructions).not.toContain('context.wakeBot');
  expect(loaded.instructions).toContain('no terminal-started web server');
  expect(api.skills.read('default', skill.id, 'references/bot-api.md').content).toContain(
    "fetch('/api/bots/' + encodeURIComponent(botId) + '/chat'",
  );
  expect(api.skills.context('default', 'scout', 'bot-scout')).toContain('/api/bots/{botId}/chat');
});
it('seeds each workspace independently and preserves edits, disabled state and removals across service restarts', () => {
  const first = api.skills.list('default')[0];
  expect(new SkillService(api.store, api.workspaces).list('default')).toHaveLength(1);
  const other = api.workspaces.create({ name: 'Other', folder: root });
  const second = api.skills.list(other.id)[0];
  expect(second.id).not.toBe(first.id);
  const edited = api.skills.save('default', updated('Personal workflow.'), first.id, first.version);
  api.skills.enable('default', first.id, false);
  const restarted = new SkillService(api.store, api.workspaces);
  expect(restarted.inspect('default', first.id)).toMatchObject({
    enabled: false,
    version: edited.version,
  });
  restarted.remove('default', first.id);
  expect(new SkillService(api.store, api.workspaces).list('default')).toEqual([]);
  expect(api.skills.list(other.id)).toHaveLength(1);
});
it('refreshes untouched bundled copies while preserving pinned loads and disabled state', () => {
  const first = api.skills.list('default')[0];
  const original = api.skills.load('default', 'scout', 'bot-scout', first.id);
  const next = new SkillService(api.store, api.workspaces, [updated('New bundled guidance.')]);
  const refreshed = next.list('default')[0];
  expect(refreshed.id).toBe(first.id);
  expect(refreshed.version).not.toBe(first.version);
  expect(next.context('default', 'scout', 'bot-scout')).not.toContain('New bundled guidance.');
  expect(next.load('default', 'scout', 'bot-scout', first.id).instructions).toContain(
    'New bundled guidance.',
  );
  expect(original.instructions).not.toContain('New bundled guidance.');
  next.enable('default', first.id, false);
  const latest = new SkillService(api.store, api.workspaces, [updated('Latest bundled guidance.')]);
  expect(latest.inspect('default', first.id).enabled).toBe(false);
  expect(latest.read.bind(latest, 'default', first.id, 'SKILL.md')).toThrow('disabled');
  latest.enable('default', first.id, true);
  expect(latest.read('default', first.id, 'SKILL.md').content).toContain(
    'Latest bundled guidance.',
  );
});
it('does not overwrite personal modifications or a pre-existing same-named user skill on an upgrade', () => {
  const first = api.skills.list('default')[0];
  api.skills.save('default', updated('My personal edits.'), first.id, first.version);
  const next = new SkillService(api.store, api.workspaces, [updated('Upgraded bundled guidance.')]);
  expect(next.inspect('default', first.id).files[0].content).toContain('My personal edits.');
  const other = api.workspaces.create({ name: 'Existing workspace', folder: root });
  const withoutDefaults = new SkillService(api.store, api.workspaces, []);
  const existing = withoutDefaults.save(other.id, updated('Existing owner workflow.'));
  const catalog = next.list(other.id);
  expect(catalog).toHaveLength(1);
  expect(catalog[0].id).toBe(existing.id);
  expect(next.inspect(other.id, existing.id).files[0].content).toContain(
    'Existing owner workflow.',
  );
});
it('respects the workspace limit and makes room for defaults only when a slot becomes available', () => {
  const withoutDefaults = new SkillService(api.store, api.workspaces, []);
  for (let i = 0; i < 200; i++)
    withoutDefaults.save('default', {
      files: [
        {
          path: 'SKILL.md',
          encoding: 'utf8',
          content: `---\nname: user-${i}\ndescription: Personal skill.\n---\nInstructions.`,
        },
      ],
    });
  expect(api.skills.list('default')).toHaveLength(200);
  expect(api.skills.list('default', 'authenticated')).toEqual([]);
  const first = withoutDefaults.list('default')[0];
  withoutDefaults.remove('default', first.id);
  expect(api.skills.list('default')).toHaveLength(200);
  expect(api.skills.list('default', 'authenticated')[0].name).toBe(
    'mukai-custom-routes-authenticated-websites',
  );
});
