import { randomUUID } from 'node:crypto';
import { helperReply, helperRequest, type ComputerHelper } from './protocol';

/** Request-scoped callbacks; only a capability invocation grants controller helpers. */
export class GuestHelpers {
  private pending = new Map<
    string,
    {
      requestId: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  constructor(private send: (frame: unknown) => void) {}
  reply(raw: unknown) {
    const parsed = helperReply.safeParse(raw);
    if (!parsed.success) return false;
    const frame = parsed.data;
    const pending = this.pending.get(frame.rpcId);
    if (pending?.requestId === frame.requestId) {
      this.pending.delete(frame.rpcId);
      pending.cleanup();
      if (frame.error) pending.reject(new Error(frame.error));
      else pending.resolve(frame.value);
    }
    return true;
  }
  forRequest(requestId: string, signal: AbortSignal): ComputerHelper {
    return (action, args) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted();
        if (this.pending.size >= 256) throw new Error('Too many pending capability helpers.');
        const rpcId = randomUUID();
        const frame = helperRequest.parse({ requestId, rpcId, action, args });
        const abort = () => {
          this.pending.delete(rpcId);
          cleanup();
          reject(new Error('Capability helper cancelled.'));
        };
        const cleanup = () => signal.removeEventListener('abort', abort);
        this.pending.set(rpcId, { requestId, resolve, reject, cleanup });
        signal.addEventListener('abort', abort, { once: true });
        try {
          this.send(frame);
        } catch (error) {
          this.pending.delete(rpcId);
          cleanup();
          reject(error);
        }
      });
  }
}

export function answerHelper(
  raw: unknown,
  pending: { helper?: ComputerHelper } | undefined,
  active: () => boolean,
  send: (frame: Record<string, unknown>) => void,
) {
  const frame = helperRequest.parse(raw);
  if (!pending || !active()) return;
  void Promise.resolve()
    .then(() => {
      if (!active()) throw new Error('Capability invocation ended.');
      if (!pending.helper) throw new Error('Controller helpers are unavailable for this request.');
      return pending.helper(frame.action, frame.args);
    })
    .then(
      (value) => {
        if (active()) send({ requestId: frame.requestId, rpcId: frame.rpcId, value });
      },
      (error) => {
        if (active())
          send({
            requestId: frame.requestId,
            rpcId: frame.rpcId,
            error: String(error instanceof Error ? error.message : error).slice(0, 2000),
          });
      },
    )
    .catch(() => {});
}
