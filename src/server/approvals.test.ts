import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './db/database';
import { ApprovalService } from './services/approvalService';
import { ApprovalRepository } from './repositories/approvalRepository';

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
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mukai-approvals-'));
  store = new Database(dir);
  service = new ApprovalService(new ApprovalRepository(store));
});
afterEach(() => {
  store.db.close();
  expect(dir.startsWith(join(tmpdir(), 'mukai-approvals-'))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
describe('Global tool approvals', () => {
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

  it('cancels pending approvals on Stop or shutdown and rejects late decisions', async () => {
    service.setMode('ask-for-approval');
    const controller = new AbortController();
    const pending = service.request(details, controller.signal, () => {});
    const id = service.state().pending[0].id;
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(service.state().pending).toEqual([]);
    expect(() => service.decide(id, true)).toThrow('no longer pending');
    await expect(service.request(details, controller.signal, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
