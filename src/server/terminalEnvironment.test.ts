import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { startApiServer } from './app';
import { seedTestBot } from './testFixtures';
import { ConversationRepository } from './repositories/conversationRepository';
import { executeTerminal } from './tools/terminal/execute';
import { computerTools } from './computer/tools';
import { GuestDispatcher } from './computer/guestDispatcher';
import type { QemuComputer } from './computer/qemuComputer';
import type { ChatActivity } from '../shared/ai';
import type { TerminalSnapshot } from '../shared/terminal';
import { MessageRepository } from './repositories/messageRepository';
import { AttachmentRepository } from './repositories/attachmentRepository';
import { FileChangeRepository } from './repositories/fileChangeRepository';

const command = (file: string) =>
  process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${file.replaceAll("'", "''")}'; exit $LASTEXITCODE`
    : `'${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}'`;

describe.each(['local', 'qemu'] as const)('%s terminal environment', (computer) => {
  let api: Awaited<ReturnType<typeof startApiServer>>, guest: GuestDispatcher;
  let directory: string, folder: string, conversationId: string, messageId: string;
  let activities: ChatActivity[];
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mukai-terminal-env-'));
    folder = join(directory, 'workspace');
    mkdirSync(folder);
    api = await startApiServer(0, {
      dataDir: join(directory, 'data'),
      memoryExtractor: async () => ({ facts: [] }),
    });
    seedTestBot(api.store);
    api.store.run(
      "UPDATE workspaces SET folder=?,computer=? WHERE id='default'",
      computer === 'qemu' ? null : folder,
      computer,
    );
    guest = new GuestDispatcher(folder, join(directory, 'guest'));
    if (computer === 'qemu') {
      vi.spyOn(api.computers, 'guest').mockReturnValue(guest as unknown as QemuComputer);
      vi.spyOn(api.computers, 'status').mockReturnValue({ kind: 'qemu', state: 'running' });
    }
    conversationId = new ConversationRepository(api.store).createPrivate('default', 'scout').id;
    messageId = randomUUID();
    activities = [];
    api.store.run(
      "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id) VALUES(?,'scout',?,'assistant','','streaming','now',?)",
      messageId,
      randomUUID(),
      conversationId,
    );
  });
  afterEach(async () => {
    await guest.shutdown();
    await api.shutdown();
    api.server.closeAllConnections();
    await new Promise<void>((done) => api.server.close(() => done()));
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  async function run(input: Parameters<typeof executeTerminal>[0]) {
    const context = {
      owner: { workspaceId: 'default', botId: 'scout', conversationId },
      signal: new AbortController().signal,
      budget: { remaining: 20 },
      onActivity: (activity: ChatActivity) => {
        const index = activities.findIndex((item) => item.id === activity.id);
        if (index < 0) activities.push(activity);
        else activities[index] = activity;
        api.store.run(
          'UPDATE messages SET activity_json=? WHERE id=?',
          JSON.stringify(activities),
          messageId,
        );
      },
      resolveTerminalEnvironment: (names: string[]) =>
        api.capabilities.environment.resolveForTerminal('default', names),
    };
    if (computer === 'local')
      return executeTerminal(input, { ...context, folder, processes: api.processes }, randomUUID());
    const tools = computerTools({
      ...context,
      computer: guest,
      vision: false,
      fileBudget: { remaining: 20 },
      recordChange() {},
      recordFile() {},
      async saveScreenshot() {
        return { artifactId: '', path: '', width: 0, height: 0 };
      },
    });
    return tools.terminal.execute!(input, {
      toolCallId: randomUUID(),
      messages: [],
      context: {},
    }) as Promise<{ ok: boolean; result?: TerminalSnapshot; error?: string }>;
  }
  const read = async (id: string, conversation: string = conversationId) => {
    const response = await fetch(
      `${api.url}/conversations/${conversation}/terminal?sessionId=${id}`,
      { headers: { Authorization: 'Bearer ' + api.token } },
    );
    return { status: response.status, value: (await response.json()) as TerminalSnapshot };
  };
  it('rejects every missing or empty saved name before starting any command', async () => {
    const file = join(folder, 'missing.cjs'),
      marker = join(folder, 'should-not-exist');
    writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`);
    api.capabilities.environment.save('default', [{ name: 'EMPTY_KEY', value: '' }]);
    const request = vi.spyOn(guest, 'request');
    const result = await run({
      command: command(file),
      envFromSettings: ['ABSENT_KEY', 'EMPTY_KEY', 'ANOTHER_KEY'],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('ABSENT_KEY, EMPTY_KEY, ANOTHER_KEY');
    expect(JSON.stringify(result)).toContain('Settings → Environment Variables');
    expect(existsSync(marker)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(
      api.processes.list({ workspaceId: 'default', botId: 'scout', conversationId }),
    ).toHaveLength(0);
  });
  it('returns missing names to the model immediately instead of requesting command approval', async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const first = requests.length === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: first
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'missing-env',
                          type: 'function',
                          function: {
                            name: 'terminal',
                            arguments: JSON.stringify({
                              command: 'echo must-not-start',
                              envFromSettings: ['MISSING_FROM_SETTINGS'],
                            }),
                          },
                        },
                      ],
                    }
                  : { content: 'Please configure the missing variable.' },
                finish_reason: first ? 'tool_calls' : 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    try {
      const address = provider.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const headers = { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' };
      await fetch(api.url + '/providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Fixture',
          kind: 'compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          defaultModel: 'fixture',
          apiKey: '',
          supportsImages: false,
          isDefault: true,
        }),
      });
      await fetch(api.url + '/approvals', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mode: 'ask-for-approval' }),
      });
      const response = await fetch(api.url + '/bots/scout/chat', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(7000),
        body: JSON.stringify({
          requestId: randomUUID(),
          text: 'Run the command.',
          attachmentIds: [],
        }),
      });
      await response.text();
      const tool = requests
        .flatMap((request) => request.messages)
        .find((message) => message.role === 'tool');
      expect(tool?.content).toContain('MISSING_FROM_SETTINGS');
      expect(tool?.content).toContain('No command was started');
      expect((await (await fetch(api.url + '/approvals', { headers })).json()).pending).toEqual([]);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
    }
  }, 12000);
  it('passes selected values to scripts and children, redacts split output, and retains accurate final status', async () => {
    const secret = 'private-terminal-token-123456';
    const resultFile = join(folder, 'child-result.json'),
      script = join(folder, 'script.cjs');
    api.capabilities.environment.save('default', [
      { name: 'SERVICE_API_KEY', value: secret },
      { name: 'UNREQUESTED', value: 'do-not-pass' },
    ]);
    writeFileSync(
      script,
      `const {spawnSync}=require('node:child_process');
const code="require('node:fs').writeFileSync("+JSON.stringify(${JSON.stringify(resultFile)})+",JSON.stringify({key:process.env.SERVICE_API_KEY,other:process.env.UNREQUESTED??null,mode:process.env.LOG_LEVEL}));";
spawnSync(process.execPath,['-e',code],{stdio:'inherit'});
console.log('started'); process.stdout.write(process.env.SERVICE_API_KEY.slice(0,8));
setTimeout(()=>{process.stdout.write(process.env.SERVICE_API_KEY.slice(8)+'\\n');console.error(Buffer.from(process.env.SERVICE_API_KEY).toString('base64'));process.exitCode=7;},700);`,
    );
    const pending = run({
      command: command(script),
      envFromSettings: ['SERVICE_API_KEY'],
      env: { LOG_LEVEL: 'debug' },
      yieldMs: 30000,
    });
    await vi.waitFor(() => expect(activities[0]?.processSessionId).toBeTruthy());
    const id = activities[0].processSessionId!;
    const early = await read(id);
    expect(early.status).toBe(200);
    expect(early.value.status).toBe('running');
    const response = await pending;
    expect(response.ok).toBe(true);
    const final = await read(id);
    expect(final.value).toMatchObject({
      status: 'exited',
      exitCode: 7,
      envFromSettings: ['SERVICE_API_KEY'],
    });
    expect(final.value.output).toContain('[redacted]');
    expect(final.value.output).not.toContain(secret);
    expect(final.value.output).not.toContain(Buffer.from(secret).toString('base64'));
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
      key: secret,
      other: null,
      mode: 'debug',
    });
    expect(JSON.stringify(activities)).not.toContain(secret);
    const messages = new MessageRepository(
      api.store,
      new AttachmentRepository(api.store),
      new FileChangeRepository(api.store),
    );
    const stale = activities.map((activity) => ({ ...activity, terminal: early.value }));
    messages.saveProgress(messageId, 'Still composing the answer.', '', stale);
    messages.finish(messageId, 'Done.', 'complete', null, '', stale);
    expect(messages.message(messageId).activity?.[0].terminal).toMatchObject({
      status: 'exited',
      exitCode: 7,
      output: final.value.output,
    });
    const other = new ConversationRepository(api.store).createPrivate('default', 'scout');
    expect((await read(id, other.id)).status).toBe(404);
    expect(
      (await fetch(`${api.url}/conversations/${conversationId}/terminal?sessionId=${id}`)).status,
    ).toBe(401);
    if (computer === 'local')
      vi.spyOn(api.processes, 'read').mockImplementation(() => {
        throw new Error('Runtime ended');
      });
    else vi.spyOn(api.computers, 'status').mockReturnValue({ kind: 'qemu', state: 'stopped' });
    const saved = await read(id);
    expect(saved.value).toMatchObject({ status: 'exited', exitCode: 7, unavailable: true });
    expect(saved.value.output).toBe(final.value.output);
  }, 15000);
  it('limits selected values to that launch and resolves fresh values for later runs', async () => {
    const file = join(folder, 'capture.cjs'),
      resultFile = join(folder, 'capture.json');
    writeFileSync(
      file,
      `require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({key:process.env.RUN_KEY??null}));`,
    );
    api.capabilities.environment.save('default', [{ name: 'RUN_KEY', value: 'first-value' }]);
    await run({ command: command(file), envFromSettings: ['RUN_KEY'], yieldMs: 30000 });
    expect(JSON.parse(readFileSync(resultFile, 'utf8')).key).toBe('first-value');
    api.capabilities.environment.save('default', [{ name: 'RUN_KEY', value: 'second-value' }]);
    await run({ command: command(file), envFromSettings: ['RUN_KEY'], yieldMs: 30000 });
    expect(JSON.parse(readFileSync(resultFile, 'utf8')).key).toBe('second-value');
    await run({ command: command(file), yieldMs: 30000 });
    expect(JSON.parse(readFileSync(resultFile, 'utf8')).key).toBeNull();
    const overlap = await run({
      command: command(file),
      envFromSettings: ['RUN_KEY'],
      env: { RUN_KEY: 'override' },
    });
    expect(overlap.ok).toBe(false);
    expect(JSON.stringify(overlap)).toContain('either env or envFromSettings');
  }, 15000);
});
