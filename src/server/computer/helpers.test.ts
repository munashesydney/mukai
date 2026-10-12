import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GuestHelpers, answerHelper } from './helpers';
import { helperRequest } from './protocol';

it('binds replies to their invocation and cancels outstanding helpers', async () => {
  const send = vi.fn();
  const broker = new GuestHelpers(send);
  const controller = new AbortController();
  const requestId = randomUUID();
  const result = broker.forRequest(requestId, controller.signal)('enqueue', [
    'provider',
    'event',
    {},
  ]);
  const frame = helperRequest.parse(send.mock.calls[0][0]);
  broker.reply({ requestId: randomUUID(), rpcId: frame.rpcId, value: 'wrong request' });
  broker.reply({ requestId, rpcId: frame.rpcId, value: 'persisted' });
  expect(await result).toBe('persisted');
  const cancelled = broker.forRequest(requestId, controller.signal)('wakeBot', ['hello']);
  const assertion = expect(cancelled).rejects.toThrow('cancelled');
  controller.abort();
  await assertion;
});

it('rejects helper errors, inactive requests and unsupported helper names', async () => {
  const frame = {
    requestId: randomUUID(),
    rpcId: randomUUID(),
    action: 'wakeBot',
    args: ['hello'],
  };
  const send = vi.fn();
  const helper = vi.fn(async () => {
    throw new Error('Target is unavailable');
  });
  answerHelper(frame, { helper }, () => true, send);
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      requestId: frame.requestId,
      rpcId: frame.rpcId,
      error: 'Target is unavailable',
    }),
  );
  answerHelper(frame, { helper }, () => false, send);
  expect(helper).toHaveBeenCalledOnce();
  expect(() => answerHelper({ ...frame, action: 'shell' }, { helper }, () => true, send)).toThrow();
});
