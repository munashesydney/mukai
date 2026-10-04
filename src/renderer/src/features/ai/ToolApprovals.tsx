import { PopupMenu } from '../../components/ui/PopupMenu';
import { Check, ChevronDown, ChevronUp, Hand, ShieldAlert } from 'lucide-react';
import { approvalStore, useApprovals } from './approvalStore';
import type { ApprovalMode, ToolApproval } from '../../../../shared/approvals';

const choices = [
  {
    mode: 'ask-for-approval',
    label: 'Ask for approval',
    description: 'Ask before tool calls, except memory',
    icon: Hand,
  },
  {
    mode: 'full-access',
    label: 'Full access',
    description: 'Run tools without asking for approval',
    icon: ShieldAlert,
  },
] as const;

export function ApprovalModePicker() {
  const state = useApprovals();
  const selected = choices.find((choice) => choice.mode === state.mode)!;
  const Icon = selected.icon;
  function choose(mode: ApprovalMode, close: () => void) {
    close();
    void approvalStore.setMode(mode);
  }
  return (
    <PopupMenu
      label="Tool approval mode for all bots"
      title="How should Mukai tools be approved?"
      placement="top"
      className="approval-mode-picker"
      menuClassName="approval-mode-menu"
      buttonClassName={`approval-mode-trigger ${state.mode}`}
      disabled={!state.loaded || state.saving}
      footer="Applies to all bots and conversations. Memory always runs without approval."
      trigger={
        <>
          <Icon size={15} />
          <span>
            {state.saving ? 'Saving…' : state.loaded ? selected.label : 'Loading permissions…'}
          </span>
          <ChevronUp size={12} />
        </>
      }
    >
      {(close) =>
        choices.map((choice) => {
          const ChoiceIcon = choice.icon;
          return (
            <button
              key={choice.mode}
              type="button"
              role="menuitemradio"
              aria-checked={state.mode === choice.mode}
              className={choice.mode}
              onClick={() => choose(choice.mode, close)}
            >
              <ChoiceIcon size={18} />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </span>
              {state.mode === choice.mode && <Check size={16} />}
            </button>
          );
        })
      }
    </PopupMenu>
  );
}

export function ToolApprovalCards({ conversationId }: { conversationId: string }) {
  const state = useApprovals();
  const groups = new Map<string, ToolApproval[]>();
  for (const request of state.pending) {
    if (request.conversationId !== conversationId || request.ask) continue;
    const group = groups.get(request.batchId) || [];
    group.push(request);
    groups.set(request.batchId, group);
  }
  return (
    <div className="tool-approval-cards">
      {state.error && (
        <div className="ai-alert" role="alert">
          {state.error}
          <button className="text-button" onClick={() => void approvalStore.refresh()}>
            Refresh permissions
          </button>
        </div>
      )}
      {[...groups].map(([batchId, requests]) => {
        const hasClarification = requests.some(
          (request) => request.ask?.action === 'clarification',
        );
        return requests.length === 1 ? (
          <ToolApprovalCard key={batchId} request={requests[0]} deciding={state.deciding} />
        ) : (
          <section
            className={`tool-approval-batch ${hasClarification ? 'tool-approval-batch--questions' : ''}`}
            key={batchId}
            aria-label="Parallel tool approvals"
          >
            <details>
              <summary>
                <Hand size={18} />
                <span>
                  <strong>
                    {requests.length}{' '}
                    {hasClarification ? 'requests need your response' : 'requests need approval'}
                  </strong>
                  <small>
                    {requests[0].botName} is waiting.{' '}
                    {hasClarification
                      ? 'Expand to review and answer each request.'
                      : 'Review each request or approve all.'}
                  </small>
                </span>
                <ChevronDown size={15} className="tool-approval-batch-chevron" />
              </summary>
              <div className="tool-approval-batch-items">
                {requests.map((request) => (
                  <ToolApprovalCard key={request.id} request={request} deciding={state.deciding} />
                ))}
              </div>
            </details>
            {!hasClarification && (
              <button
                type="button"
                className="button button--primary button--small tool-approval-batch-approve"
                disabled={requests.some((request) => state.deciding.includes(request.id))}
                onClick={() =>
                  void approvalStore.decideBatch(
                    conversationId,
                    batchId,
                    requests.map((request) => request.id),
                  )
                }
              >
                Approve all
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ToolApprovalCard({ request, deciding }: { request: ToolApproval; deciding: string[] }) {
  return (
    <section className="tool-approval-card" aria-label={`Approval for ${request.toolName}`}>
      <div className="tool-approval-heading">
        <Hand size={18} />
        <strong>
          {request.botName} wants to use {request.toolName}
        </strong>
      </div>
      <p role="status">Waiting for your approval. This tool has not run.</p>
      <details>
        <summary>Review tool arguments</summary>
        <pre>{JSON.stringify(request.input, null, 2)}</pre>
      </details>
      <div className="tool-approval-actions">
        <button
          type="button"
          className="button button--small"
          disabled={deciding.includes(request.id)}
          onClick={() => void approvalStore.decide(request.id, false)}
        >
          Reject
        </button>
        <button
          type="button"
          className="button button--primary button--small"
          disabled={deciding.includes(request.id)}
          onClick={() => void approvalStore.decide(request.id, true)}
        >
          Approve tool call
        </button>
      </div>
    </section>
  );
}
