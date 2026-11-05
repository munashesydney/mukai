import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { GuestDispatcher } from './computer/guestDispatcher';
import type { QemuComputer } from './computer/qemuComputer';
import type { ApprovalState } from '../shared/approvals';
import type { ChatActivity } from '../shared/ai';
import { WebSearchService } from './services/webSearchService';

describe.each(['local', 'qemu'] as const)('%s code execution chat', (computer) => {
  let api: Awaited<ReturnType<typeof startApiServer>>,
    fixture: Server,
    root: string,
    folder: string;
  let guest: GuestDispatcher | undefined;
  let code: string;
  let seen: {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  }[];
  let step: number;

  async function request(path: string, method = 'GET', input?: unknown) {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  }
  async function chat() {
    const response = await fetch(api.url + '/bots/scout/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: randomUUID(),
        text: 'Process the project using JavaScript.',
        attachmentIds: [],
      }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }
  async function approval(toolName: string) {
    let result: ApprovalState['pending'][number] | undefined;
    await vi.waitFor(
      async () => {
        result = ((await request('/approvals')).value as ApprovalState).pending.find(
          (item) => item.toolName === toolName,
        );
        expect(result).toBeDefined();
      },
      { timeout: 5000 },
    );
    return result!;
  }
  function result() {
    return JSON.parse(
      seen
        .at(-1)!
        .messages.filter((item) => item.role === 'tool')
        .at(-1)!.content,
    );
  }
  function activities(): ChatActivity[] {
    return JSON.parse(
      String(
        api.store.get(
          "SELECT activity_json FROM messages WHERE role='assistant' ORDER BY sequence DESC LIMIT 1",
        )?.activity_json || '[]',
      ),
    );
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mukai-code-chat-'));
    folder = join(root, 'workspace');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'TODO alpha\nTODO beta\n');
    api = await startApiServer(0, { dataDir: join(root, 'data') });
    seedTestBot(api.store);
    api.store.run("UPDATE workspaces SET memory_enabled=0 WHERE id='default'");
    await request('/workspaces/default', 'PUT', { name: 'Test', folder });
    if (computer === 'qemu') {
      api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
      guest = new GuestDispatcher(folder, join(root, 'guest-data'));
      vi.spyOn(api.computers, 'guest').mockReturnValue(guest as unknown as QemuComputer);
    }
    code =
      'const r = await tools.file_operations({action:"search_files",query:"TODO",path:"."}); print(r.ok ? (r.matches || r.result.matches).length : r);';
    seen = [];
    step = 0;
    fixture = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      const call = step++ === 0;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'script-call',
                          type: 'function',
                          function: { name: 'execute_code', arguments: JSON.stringify({ code }) },
                        },
                      ],
                    }
                  : { content: 'Finished.' },
                finish_reason: call ? 'tool_calls' : 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    expect(
      (
        await request('/providers', 'POST', {
          name: 'Fixture',
          kind: 'compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          defaultModel: 'test',
          apiKey: '',
          supportsImages: false,
          isDefault: true,
          contextWindowTokens: 65536,
        })
      ).status,
    ).toBe(201);
  });
  afterEach(async () => {
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    await guest?.shutdown();
    guest = undefined;
    vi.restoreAllMocks();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    expect(root.startsWith(join(tmpdir(), 'mukai-code-chat-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('runs tool pipelines with normal activity and only the script result in model context', async () => {
    await chat();
    expect(result()).toMatchObject({ ok: true, output: '2\n', toolCalls: 1 });
    const toolMessages = seen.at(-1)!.messages.filter((item) => item.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(JSON.stringify(toolMessages)).not.toContain('TODO alpha');
    expect(activities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'execute_code', status: 'complete' }),
        expect.objectContaining({
          id: 'script-call:code:1',
          tool: 'file_operations',
          status: 'complete',
        }),
      ]),
    );
    expect(JSON.stringify(seen[0].messages)).toContain('Prefer execute_code');
  });

  it('passes responses larger than context previews to the script', async () => {
    const payload = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      text: 'PRIVATE_INTERMEDIATE'.repeat(20),
    }));
    vi.spyOn(WebSearchService.prototype, 'execute').mockResolvedValue({ rows: payload } as never);
    code =
      'const r = await tools.web_search({action:"search",query:"fixture"}); print(r.result.rows.length, r.result.rows.at(-1).id);';
    await chat();
    expect(result()).toMatchObject({ ok: true, output: '10000 9999\n' });
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain('PRIVATE_INTERMEDIATE');
    // Rich previews remain available in the UI, but must not leak through the
    // history reconstruction used for the next user message.
    const child = activities().find((item) => item.id === 'script-call:code:1');
    expect(child?.parentToolCallId).toBe('script-call');
    expect(child?.summary).toContain('PRIVATE_INTERMEDIATE');
    await chat();
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain('PRIVATE_INTERMEDIATE');
    expect(JSON.stringify(seen.at(-1)!.messages)).toContain('10000 9999');
  });

  it('requires separate approvals for the script and its internal action', async () => {
    api.approvals.setMode('ask-for-approval');
    code =
      'const r = await tools.file_operations({action:"write_file",path:"created.txt",content:"approved"}); print(r.ok);';
    const running = chat();
    const parent = await approval('execute_code');
    expect(existsSync(join(folder, 'created.txt'))).toBe(false);
    await request('/approvals/' + parent.id, 'POST', { approved: true });
    const child = await approval('file_operations');
    expect(child.toolCallId).toBe('script-call:code:1');
    expect(existsSync(join(folder, 'created.txt'))).toBe(false);
    await request('/approvals/' + child.id, 'POST', { approved: true });
    await running;
    expect(readFileSync(join(folder, 'created.txt'), 'utf8')).toBe('approved');
    expect(result()).toMatchObject({ ok: true, output: 'true\n' });
  });

  it('honors a denial inside the script without writing', async () => {
    api.approvals.setMode('ask-for-approval');
    code =
      'const r = await tools.file_operations({action:"write_file",path:"denied.txt",content:"denied"}); print(r);';
    const running = chat();
    await request('/approvals/' + (await approval('execute_code')).id, 'POST', { approved: true });
    await request('/approvals/' + (await approval('file_operations')).id, 'POST', {
      approved: false,
      reason: 'Do not write this file.',
    });
    await running;
    expect(existsSync(join(folder, 'denied.txt'))).toBe(false);
    expect(result().output).toContain('Do not write this file.');
  });

  it('does not expose unassigned tools or accept invalid nested arguments', async () => {
    await request('/tools/assignments', 'PUT', {
      botId: 'scout',
      toolId: 'file_operations',
      enabled: false,
    });
    code = 'print(typeof tools.file_operations); await tools.web_search({action:"invalid"});';
    const search = vi.spyOn(WebSearchService.prototype, 'execute');
    await chat();
    expect(result()).toMatchObject({
      ok: false,
      output: 'undefined\n',
      error: expect.stringContaining('Invalid arguments'),
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('can independently disable the family without disabling System', async () => {
    await request('/tools/assignments', 'PUT', {
      botId: 'scout',
      toolId: 'execute_code',
      enabled: false,
    });
    await chat();
    const names = seen[0].tools.map((x) => x.function.name);
    expect(names).not.toContain('execute_code');
    expect(names).toContain('system');
    expect(activities().some((x) => x.tool === 'execute_code' && x.status === 'complete')).toBe(
      false,
    );
  });

  it('stops an internal pending approval without executing it', async () => {
    api.approvals.setMode('ask-for-approval');
    code =
      'await tools.file_operations({action:"write_file",path:"stopped.txt",content:"stopped"});';
    const running = chat();
    await request('/approvals/' + (await approval('execute_code')).id, 'POST', { approved: true });
    const child = await approval('file_operations');
    await request('/bots/scout/stop', 'POST');
    await running;
    expect(existsSync(join(folder, 'stopped.txt'))).toBe(false);
    expect((await request('/approvals/' + child.id, 'POST', { approved: true })).status).toBe(409);
  });

  it('rechecks assignment after an internal approval was requested', async () => {
    api.approvals.setMode('ask-for-approval');
    code =
      'const r = await tools.file_operations({action:"write_file",path:"revoked.txt",content:"revoked"}); print(r);';
    const running = chat();
    await request('/approvals/' + (await approval('execute_code')).id, 'POST', { approved: true });
    const child = await approval('file_operations');
    await request('/tools/assignments', 'PUT', {
      botId: 'scout',
      toolId: 'file_operations',
      enabled: false,
    });
    await request('/approvals/' + child.id, 'POST', { approved: true });
    await running;
    expect(existsSync(join(folder, 'revoked.txt'))).toBe(false);
    expect(result()).toMatchObject({ ok: false, error: expect.stringContaining('not assigned') });
  });

  it('does not replay a running script or its nested action after a restart', async () => {
    api.approvals.setMode('ask-for-approval');
    code =
      'await tools.file_operations({action:"write_file",path:"replayed.txt",content:"must not run"});';
    const running = chat();
    await request('/approvals/' + (await approval('execute_code')).id, 'POST', { approved: true });
    const child = await approval('file_operations');
    await api.shutdown();
    await running;
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    api = await startApiServer(0, { dataDir: join(root, 'data') });
    if (guest) vi.spyOn(api.computers, 'guest').mockReturnValue(guest as unknown as QemuComputer);
    await vi.waitFor(
      () => {
        expect(seen.length).toBe(2);
        expect(JSON.stringify(seen.at(-1)!.messages)).toContain('result is uncertain');
      },
      { timeout: 5000 },
    );
    expect(existsSync(join(folder, 'replayed.txt'))).toBe(false);
    expect((await request('/approvals/' + child.id, 'POST', { approved: true })).status).toBe(409);
    expect(((await request('/approvals')).value as ApprovalState).pending).toEqual([]);
  });
});
