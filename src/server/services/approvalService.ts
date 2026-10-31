import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalState,
  ToolApproval,
} from '../../shared/approvals';
import type { ApprovalRepository, ApprovalCheckpoint } from '../repositories/approvalRepository';
import { ApiError } from '../config';
import type { AskInput, AskResponse } from '../../shared/ask';
import { askDefinition } from '../tools/ask/definition';
import { inPursuitExecution, pausePursuitTask } from './pursuitScheduler';

type Decision = ApprovalDecision | string;

interface PendingApproval {
  request: ApprovalCheckpoint;
  restoring?: boolean;
  settle(decision: Decision): void;
}

/** One policy per workspace; a grant authorizes exactly one invocation. */
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
    return this.closing && this.hasCheckpoint(messageId);
  }
  hasCheckpoint(messageId: string) {
    return this.checkpoints().some((request) => request.messageId === messageId);
  }
  checkpoints(): ToolApproval[] {
    return [...this.pending.values()].map((item) => item.request);
  }
  discard(messageId: string) {
    for (const [id, item] of this.pending)
      if (item.request.messageId === messageId) {
        this.pending.delete(id);
        this.repository.remove(id);
      }
  }

  forgetWorkspace(id: string, botIds: string[]) {
    for (const item of this.pending.values()) {
      if (item.request.target?.workspaceId === id || botIds.includes(item.request.botId))
        this.discard(item.request.messageId);
    }
  }

  mode(workspaceId = 'default'): ApprovalMode {
    return this.repository.mode(workspaceId);
  }

  state(workspaceId = 'default'): ApprovalState {
    return {
      mode: this.mode(workspaceId),
      pending: [...this.pending.values()]
        .filter(({ request }) => request.decision === undefined)
        .map(({ request }) => {
          const blockedParents = this.repository.blockedParents(request);
          return blockedParents.length ? { ...request, blockedParents } : request;
        }),
    };
  }

  setMode(mode: ApprovalMode, workspaceId = 'default') {
    this.repository.setMode(mode, workspaceId);
    // Existing requests still need an explicit decision. Changing mode is not a grant.
    return this.state(workspaceId);
  }

  waiting(messageId: string) {
    return [...this.pending.values()].some(
      (item) => item.request.messageId === messageId && item.request.decision === undefined,
    );
  }

  decide(id: string, approved: boolean, workspaceId = 'default', reason?: string) {
    const item = this.pending.get(id);
    if (!item || item.request.decision !== undefined)
      throw new ApiError(409, 'This tool approval is no longer pending.');
    if (item.request.ask?.action === 'clarification')
      throw new ApiError(400, 'This request needs an answer, not an approval.');
    if (reason !== undefined) {
      if (approved) throw new ApiError(400, 'Only denied approvals accept a reason.');
      reason = reason.trim();
      if (!reason || reason.length > 16000)
        throw new ApiError(400, 'Enter a reason between 1 and 16000 characters.');
    }
    item.settle(reason === undefined ? approved : { approved: false, reason });
    return this.state(workspaceId);
  }
  answer(id: string, answer: string, workspaceId = 'default') {
    const item = this.pending.get(id);
    if (!item || item.request.decision !== undefined)
      throw new ApiError(409, 'This request is no longer pending.');
    if (item.request.ask?.action !== 'clarification')
      throw new ApiError(400, 'This request needs an approval decision.');
    answer = answer.trim();
    if (!answer || answer.length > 16000)
      throw new ApiError(400, 'Enter an answer between 1 and 16000 characters.');
    item.settle(answer);
    return this.state(workspaceId);
  }

  decideBatch(
    conversationId: string,
    batchId: string,
    ids: string[],
    approved: boolean,
    workspaceId = 'default',
  ) {
    // Validate the entire snapshot before granting anything. Calls arriving later
    // still require their own decision, even when they belong to this step.
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new ApiError(400, 'Select distinct pending tool approvals.');
    const items = ids.map((id) => {
      const item = this.pending.get(id);
      if (!item || item.request.decision !== undefined)
        throw new ApiError(409, 'This tool approval is no longer pending.');
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
    return this.state(workspaceId);
  }

  async request(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
    force = false,
  ): Promise<ApprovalDecision> {
    signal.throwIfAborted();
    // This reserved built-in records a validated outcome; it performs no external action.
    if (!force && details.toolName === 'report_pursuit') {
      const restored = this.restored(details);
      if (restored) {
        this.repository.remove(restored.request.id);
        this.pending.delete(restored.request.id);
        onChange();
      }
      return true;
    }
    if (
      !force &&
      !this.restored(details) &&
      (['memory', 'conversations'].includes(details.toolName) ||
        this.mode(this.repository.workspaceId(details)) === 'full-access')
    )
      return true;
    const decision = await this.wait(details, signal, onChange);
    return typeof decision === 'object' ? decision : decision === true;
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
        : {
            action: 'approval',
            approved: decision === true,
            ...(typeof decision === 'object' ? { reason: decision.reason } : {}),
          };
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

  private async wait(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
    beforeResolve?: (decision: Decision) => void,
  ): Promise<Decision> {
    try {
      const decision = await pausePursuitTask(() =>
        this.waitForDecision(details, signal, onChange, beforeResolve),
      );
      this.removeDecision(details);
      return decision;
    } catch (error) {
      if (!this.closing) this.removeDecision(details);
      throw error;
    }
  }
  private removeDecision(details: Omit<ToolApproval, 'id' | 'createdAt'>) {
    const restored = this.restored(details);
    if (restored?.request.decision !== undefined) {
      this.pending.delete(restored.request.id);
      this.repository.remove(restored.request.id);
    }
  }

  private waitForDecision(
    details: Omit<ToolApproval, 'id' | 'createdAt'>,
    signal: AbortSignal,
    onChange: () => void,
    beforeResolve?: (decision: Decision) => void,
  ): Promise<Decision> {
    signal.throwIfAborted();
    const restored = this.restored(details);
    if (restored?.request.decision !== undefined) return Promise.resolve(restored.request.decision);
    const retainDecision = inPursuitExecution();
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
            if (retainDecision) {
              const saved = { ...request, decision };
              this.repository.save(saved);
              this.pending.set(request.id, {
                request: saved,
                restoring: true,
                settle() {
                  throw new ApiError(409, 'This tool approval is no longer pending.');
                },
              });
              signal.removeEventListener('abort', abort);
              onChange();
            } else cleanup();
          });
          resolve(decision);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      onChange();
    });
  }
}
