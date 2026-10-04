import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './db/database';
import { ApprovalService } from './services/approvalService';
import { ApprovalRepository } from './repositories/approvalRepository';
import { seedTestBot } from './testFixtures';
import { ConversationRepository } from './repositories/conversationRepository';
import { PursuitRepository } from './repositories/pursuitRepository';

let store: Database;
let service: ApprovalService;
let dir: string;
const details = {
  toolCallId: 'call-1',
  toolName: 'file_operations',
  input: { action: 'read_file', path: 'notes.txt' },
  botId: 'bot-1',
  botName: 'Mukai',
  conversationId: 'chat-1',
  messageId: 'message-1',
  batchId: 'batch-1',
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-approvals-'));
  store = new Database(dir);
  seedTestBot(store);
  for (const id of ['message-1', 'message-2'])
    store.run(
      "INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id) VALUES(?,'scout',?,'assistant','','streaming',?,'bot-scout')",
      id,
      id,
      new Date().toISOString(),
    );
  service = new ApprovalService(new ApprovalRepository(store));
});
afterEach(() => {
  store.db.close();
  expect(dir.startsWith(join(tmpdir(), 'mukai-approvals-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
describe('Global tool approvals', () => {
  it('always exempts every built-in memory action in ask-for-approval mode', async () => {
    service.setMode('ask-for-approval');
    for (const action of ['add', 'search', 'forget']) {
      expect(
        await service.request(
          { ...details, toolName: 'memory', input: { action } },
          new AbortController().signal,
          () => {},
        ),
      ).toBe(true);
    }
    expect(service.state().pending).toEqual([]);
  });

  it('attaches the exact private chat, space, and pursuit run destination to requests', async () => {
    service.setMode('ask-for-approval');
    const conversations = new ConversationRepository(store);
    const privateChat = conversations.createPrivate('default', 'scout');
    const space = conversations.create('default', {
      name: 'Team space',
      description: '',
      botIds: ['scout'],
    });
    const pursuits = new PursuitRepository(store);
    const pursuit = pursuits.create(
      'default',
      'scout',
      {
        name: 'Research',
        objective: 'Review',
        successCriteria: 'Verified',
        firstRunAt: null,
        deadline: null,
      },
      Date.now(),
    );
    const run = pursuits.claim(pursuit.id, 'manual', Date.now())!;
    for (const conversation of [
      privateChat,
      space,
      { id: run.conversationId, kind: 'pursuit_run', name: pursuit.name },
    ]) {
      const pending = service.request(
        { ...details, conversationId: conversation.id },
        new AbortController().signal,
        () => {},
      );
      const item = service.state().pending[0];
      expect(item.target).toMatchObject({
        kind: conversation.kind,
        name: conversation.name,
        workspaceId: 'default',
      });
      if (conversation.kind === 'pursuit_run')
        expect(item.target).toMatchObject({ pursuitId: pursuit.id, runId: run.id });
      service.decide(item.id, false);
      await pending;
    }
  });
  it('preserves the existing full-access default and persists the shared mode across restarts', async () => {
    expect(await service.request(details, new AbortController().signal, () => {})).toBe(true);
    expect(service.state().pending).toEqual([]);
    service.setMode('ask-for-approval');
    store.db.close();
    store = new Database(dir);
    expect(new ApprovalService(new ApprovalRepository(store)).mode()).toBe('ask-for-approval');
  });

  it('requires separate grants for concurrent calls across bots, custom tools and conversations', async () => {
    service.setMode('ask-for-approval');
    const onChange = vi.fn();
    const first = service.request(details, new AbortController().signal, onChange);
    const second = service.request(
      {
        ...details,
        botId: 'bot-2',
        conversationId: 'chat-2',
        messageId: 'message-2',
        toolName: 'custom_weather',
      },
      new AbortController().signal,
      onChange,
    );
    const [a, b] = service.state().pending;
    expect(service.waiting('message-1')).toBe(true);
    service.decide(a.id, true);
    expect(await first).toBe(true);
    expect(service.state().pending).toEqual([b]);
    expect(() => service.decide(a.id, true)).toThrow('no longer pending');
    service.decide(b.id, false);
    expect(await second).toBe(false);
    expect(service.state().pending).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('approves only the selected snapshot from one model step and leaves later calls pending', async () => {
    service.setMode('ask-for-approval');
    const first = service.request(details, new AbortController().signal, () => {});
    const second = service.request(
      { ...details, toolCallId: 'call-2' },
      new AbortController().signal,
      () => {},
    );
    const ids = service.state().pending.map((item) => item.id);
    const later = service.request(
      { ...details, toolCallId: 'call-3' },
      new AbortController().signal,
      () => {},
    );
    service.decideBatch(details.conversationId, details.batchId, ids, true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(service.state().pending.map((item) => item.toolCallId)).toEqual(['call-3']);
    service.decide(service.state().pending[0].id, false);
    expect(await later).toBe(false);
  });

  it('rejects mixed, duplicate and stale batches without granting any remaining requests', async () => {
    service.setMode('ask-for-approval');
    const requests = [
      service.request(details, new AbortController().signal, () => {}),
      service.request(
        { ...details, conversationId: 'other-chat' },
        new AbortController().signal,
        () => {},
      ),
      service.request({ ...details, batchId: 'next-step' }, new AbortController().signal, () => {}),
    ];
    const [first, otherChat, nextStep] = service.state().pending;
    for (const ids of [
      [first.id, otherChat.id],
      [first.id, nextStep.id],
      [first.id, 'expired-id'],
      [first.id, first.id],
      [],
    ]) {
      expect(() =>
        service.decideBatch(details.conversationId, details.batchId, ids, true),
      ).toThrow();
      expect(service.state().pending).toHaveLength(3);
    }
    for (const item of service.state().pending) service.decide(item.id, false);
    expect(await Promise.all(requests)).toEqual([false, false, false]);
  });

  it('does not release an already-pending call when the global mode changes', async () => {
    service.setMode('ask-for-approval');
    const controller = new AbortController();
    const pending = service.request(details, controller.signal, () => {});
    const settled = vi.fn();
    void pending.then(settled);
    service.setMode('full-access');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(service.state().pending).toHaveLength(1);
    service.decide(service.state().pending[0].id, false);
    expect(await pending).toBe(false);
    expect(await service.request(details, controller.signal, () => {})).toBe(true);
  });

  it('persists exact pending cards through shutdown and reattaches them even if the mode changed', async () => {
    service.setMode('ask-for-approval');
    const controller = new AbortController();
    const original = service.request(details, controller.signal, () => {});
    const pending = service.state().pending;
    service.setMode('full-access');
    service.suspend();
    const assertion = expect(original).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    store.db.close();
    store = new Database(dir);
    service = new ApprovalService(new ApprovalRepository(store));
    expect(service.state().pending).toEqual(pending);
    expect(() => service.decide(pending[0].id, true)).toThrow('restoring');
    const restored = service.request(details, new AbortController().signal, () => {});
    expect(service.state().pending).toEqual(pending);
    service.decide(pending[0].id, true);
    expect(await restored).toBe(true);
    expect(new ApprovalRepository(store).pending()).toEqual([]);
  });

  it('cancels pending approvals on Stop and rejects late decisions', async () => {
    service.setMode('ask-for-approval');
    const controller = new AbortController();
    const pending = service.request(details, controller.signal, () => {});
    const id = service.state().pending[0].id;
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(service.state().pending).toEqual([]);
    expect(new ApprovalRepository(store).pending()).toEqual([]);
    expect(() => service.decide(id, true)).toThrow('no longer pending');
    await expect(service.request(details, controller.signal, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
