import { randomUUID } from 'node:crypto';
import type { ApprovalMode, ApprovalState, ToolApproval } from '../../shared/approvals';
import type { ApprovalRepository } from '../repositories/approvalRepository';
import { ApiError } from '../config';

interface PendingApproval {
  request: ToolApproval;
  settle(approved: boolean): void;
}

/** One policy for the entire installation; a grant authorizes exactly one invocation. */
export class ApprovalService {
  private pending = new Map<string, PendingApproval>();
  constructor(private repository: ApprovalRepository) {}

  mode(): ApprovalMode {
    return this.repository.mode();
  }

  state(): ApprovalState {
    return { mode: this.mode(), pending: [...this.pending.values()].map((item) => item.request) };
  }

  setMode(mode: ApprovalMode) {
    this.repository.setMode(mode);
    // Existing requests still need an explicit decision. Changing mode is not a grant.
    return this.state();
  }

  waiting(messageId: string) {
    return [...this.pending.values()].some((item) => item.request.messageId === messageId);
  }

  decide(id: string, approved: boolean) {
    const item = this.pending.get(id);
    if (!item) throw new ApiError(409, 'This tool approval is no longer pending.');
    item.settle(approved);
    return this.state();
  }

  async request(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (this.mode() === 'full-access') return true;
    const request: ToolApproval = {
      ...details,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(request.id);
        signal.removeEventListener('abort', abort);
        onChange();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      this.pending.set(request.id, {
        request,
        settle: (approved) => {
          cleanup();
          resolve(approved);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      onChange();
    });
  }
}
