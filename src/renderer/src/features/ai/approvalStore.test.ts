import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalState } from '../../../../shared/approvals';
import { approvalService } from '../../services/approvalService';
import { approvalStore } from './approvalStore';

vi.mock('../../services/approvalService', () => ({
  approvalService: {
    state: vi.fn(),
    setMode: vi.fn(),
    decide: vi.fn(),
    decideBatch: vi.fn(),
    answer: vi.fn(),
  },
}));

const fullAccess: ApprovalState = { mode: 'full-access', pending: [] };
const asking: ApprovalState = { mode: 'ask-for-approval', pending: [] };

/** Let a fire-and-forget pass run to completion before the next test starts. */
const drain = async () => {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
};

function held(): { promise: Promise<ApprovalState>; answer: (state: ApprovalState) => void } {
  let answer!: (state: ApprovalState) => void;
  const promise = new Promise<ApprovalState>((resolve) => (answer = resolve));
  return { promise, answer };
}

/**
 * The error above the approval cards is the only sign that polling has stopped
 * working, so "Refresh permissions" has to be a real retry. It used to be dropped on
 * the floor whenever it landed while a poll was still in flight — which, at one
 * request per second against a server that is slow rather than dead, is most presses.
 */
describe('approval refresh', () => {
  beforeEach(() => {
    vi.mocked(approvalService.state).mockReset();
    vi.mocked(approvalService.state).mockImplementation(async () => fullAccess);
  });

  it('runs a second look for a refresh pressed during the first one', async () => {
    const heldLook = held();
    vi.mocked(approvalService.state).mockImplementationOnce(() => heldLook.promise);

    const first = approvalStore.refresh();
    expect(await approvalStore.refresh()).toBe('busy');
    expect(approvalService.state).toHaveBeenCalledTimes(1);

    heldLook.answer(fullAccess);
    expect(await first).toBe('changed');
    // The finishing pass issues the queued retry itself, before its caller resumes.
    expect(approvalService.state).toHaveBeenCalledTimes(2);
    await drain();
  });

  it('retries once, not once per press, when the button is hammered', async () => {
    const heldLook = held();
    vi.mocked(approvalService.state).mockImplementationOnce(() => heldLook.promise);

    const first = approvalStore.refresh();
    const presses = await Promise.all([
      approvalStore.refresh(),
      approvalStore.refresh(),
      approvalStore.refresh(),
    ]);
    expect(presses).toEqual(['busy', 'busy', 'busy']);

    heldLook.answer(asking);
    expect(await first).toBe('changed');
    expect(approvalService.state).toHaveBeenCalledTimes(2);
    await drain();
  });
});

/**
 * Browsers cancel in-flight polls as a matter of course: a page navigates, the view that
 * started the request unmounts, or a caller aborts through its own signal. Reading one as
 * an outage put the "Cannot reach Mukai's server" banner above a panel whose server was
 * answering every other request with 200s, and it survived until the next poll landed.
 */
describe('a cancelled look', () => {
  beforeEach(() => {
    vi.mocked(approvalService.state).mockReset();
    vi.mocked(approvalService.state).mockImplementation(async () => fullAccess);
  });

  it('keeps the last good answer instead of reporting an outage', async () => {
    const cancelled = Object.assign(new Error('The user aborted a request.'), {
      name: 'AbortError',
    });
    vi.mocked(approvalService.state).mockRejectedValueOnce(cancelled);

    expect(await approvalStore.refresh()).toBe('busy');
    expect(approvalService.state).toHaveBeenCalledTimes(1);
    // Nothing latched: the next look is an ordinary one, not a recovery.
    expect(['changed', 'unchanged']).toContain(await approvalStore.refresh());
    await drain();
  });

  it('still reports an outage when the server itself refused', async () => {
    vi.mocked(approvalService.state).mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
    );

    expect(await approvalStore.refresh()).toBe('failed');
    await drain();
  });
});
