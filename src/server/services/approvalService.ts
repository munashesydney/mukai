import { randomUUID } from 'node:crypto';
import type { ApprovalMode, ApprovalState, ToolApproval } from '../../shared/approvals';
import type { ApprovalRepository } from '../repositories/approvalRepository';
import { ApiError } from '../config';
import type { AskInput, AskResponse } from '../../shared/ask';
import { askDefinition } from '../tools/ask/definition';

type Decision = boolean | string;

interface PendingApproval {
  request: ToolApproval;
  restoring?: boolean;
  settle(decision: Decision): void;
}

/** One policy for the entire installation; a grant authorizes exactly one invocation. */
export class ApprovalService {
  private pending = new Map<string, PendingApproval>();
  private closing = false;
  constructor(private repository: ApprovalRepository) {
    for (const request of repository.pending())
      this.pending.set(request.id, {
        request,
        restoring: true,
        settle() {
          throw new ApiError(409, 'This approval is restoring. Try again shortly.');
        },
      });
  }
  suspend() {
    this.closing = true;
  }
  suspending(messageId: string) {
    return this.closing && this.waiting(messageId);
  }
  discard(messageId: string) {
    for (const [id, item] of this.pending)
      if (item.request.messageId === messageId) {
        this.pending.delete(id);
        this.repository.remove(id);
      }
  }

  mode(): ApprovalMode {
    return this.repository.mode();
  }

  state(): ApprovalState {
    return {
      mode: this.mode(),
      pending: [...this.pending.values()].map(({ request }) => {
        const blockedParents = this.repository.blockedParents(request);
        return blockedParents.length ? { ...request, blockedParents } : request;
      }),
    };
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
    if (item.request.ask?.action === 'clarification')
      throw new ApiError(400, 'This request needs an answer, not an approval.');
    item.settle(approved);
    return this.state();
  }
  answer(id: string, answer: string) {
    const item = this.pending.get(id);
    if (!item) throw new ApiError(409, 'This request is no longer pending.');
    if (item.request.ask?.action !== 'clarification')
      throw new ApiError(400, 'This request needs an approval decision.');
    answer = answer.trim();
    if (!answer || answer.length > 16000)
      throw new ApiError(400, 'Enter an answer between 1 and 16000 characters.');
    item.settle(answer);
    return this.state();
  }

  decideBatch(conversationId: string, batchId: string, ids: string[], approved: boolean) {
    // Validate the entire snapshot before granting anything. Calls arriving later
    // still require their own decision, even when they belong to this step.
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new ApiError(400, 'Select distinct pending tool approvals.');
    const items = ids.map((id) => {
      const item = this.pending.get(id);
      if (!item) throw new ApiError(409, 'This tool approval is no longer pending.');
      if (item.restoring) throw new ApiError(409, 'This approval is restoring. Try again shortly.');
      if (item.request.ask?.action === 'clarification')
        throw new ApiError(400, 'Clarifications must be answered individually.');
      if (item.request.conversationId !== conversationId || item.request.batchId !== batchId)
        throw new ApiError(
          409,
          'These approvals do not belong to the same conversation and batch.',
        );
      return item;
    });
    for (const item of items) item.settle(approved);
    return this.state();
  }

  async request(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
    force = false,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (
      !force &&
      !this.restored(details) &&
      (['memory', 'conversations'].includes(details.toolName) || this.mode() === 'full-access')
    )
      return true;
    return (await this.wait(details, signal, onChange)) as boolean;
  }

  async ask(
    details: Omit<ToolApproval, 'id' | 'createdAt' | 'ask'>,
    input: AskInput,
    signal: AbortSignal,
    onChange: () => void,
    onAnswer: (response: AskResponse) => void,
  ): Promise<AskResponse> {
    const question = askDefinition.inputSchema.parse(input);
    const response = (decision: Decision): AskResponse =>
      question.action === 'clarification'
        ? { action: 'clarification', answer: String(decision) }
        : { action: 'approval', approved: decision === true };
    const decision = await this.wait({ ...details, ask: question }, signal, onChange, (decision) =>
      onAnswer(response(decision)),
    );
    return response(decision);
  }

  private restored(details: Omit<ToolApproval, 'id' | 'createdAt'>) {
    return [...this.pending.values()].find(
      ({ request, restoring }) =>
        restoring &&
        request.messageId === details.messageId &&
        request.conversationId === details.conversationId &&
        request.batchId === details.batchId &&
        request.toolCallId === details.toolCallId,
    );
  }

  private wait(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
    beforeResolve?: (decision: Decision) => void,
  ): Promise<Decision> {
    signal.throwIfAborted();
    const restored = this.restored(details);
    const target = this.repository.target(details.conversationId);
    const request: ToolApproval = restored?.request || {
      ...details,
      ...(target ? { target } : {}),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.repository.save(request);
    return new Promise<Decision>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(request.id);
        this.repository.remove(request.id);
        signal.removeEventListener('abort', abort);
        onChange();
      };
      const abort = () => {
        if (!this.closing) cleanup();
        else signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      this.pending.set(request.id, {
        request,
        settle: (decision) => {
          this.repository.resolve(() => {
            beforeResolve?.(decision);
            cleanup();
          });
          resolve(decision);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      onChange();
    });
  }
}
