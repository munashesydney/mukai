import { PopupMenu } from '../../components/ui/PopupMenu';
import { Checkbox } from '../../components/ui/Checkbox';
import { Tooltip } from '../../components/ui/Tooltip';
import { Check, ChevronDown, ChevronUp, Hand, ShieldAlert } from 'lucide-react';
import { approvalStore, useApprovals } from './approvalStore';
import type { ApprovalMode, ToolApproval } from '../../../../shared/approvals';
import { approvalBlocksConversation } from '../../../../shared/approvals';

const choices = [
  {
    mode: 'ask-for-approval',
    label: 'Ask for approval',
    description: 'Review tool calls before they run',
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
      label="Tool approval mode for this workspace"
      title="How should Mukai tools be approved?"
      placement="top"
      className="approval-mode-picker"
      menuClassName="approval-mode-menu"
      buttonClassName={`approval-mode-trigger ${state.mode}`}
      disabled={!state.loaded || state.saving}
      footer="Applies to all bots and conversations in this workspace. Explicit confirmations still require your response."
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
    if (!approvalBlocksConversation(request, conversationId) || request.ask) continue;
    const key = request.conversationId + ':' + request.batchId;
    const group = groups.get(key) || [];
    group.push(request);
    groups.set(key, group);
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
      {[...groups].map(([key, requests]) => {
        const batchId = requests[0].batchId;
        const delegated = requests[0].conversationId !== conversationId;
        const hasClarification = requests.some(
          (request) => request.ask?.action === 'clarification',
        );
        return requests.length === 1 ? (
          <ToolApprovalCard
            key={key}
            request={requests[0]}
            deciding={state.deciding}
            delegated={delegated}
          />
        ) : (
          <section
            className={`tool-approval-batch ${hasClarification ? 'tool-approval-batch--questions' : ''}`}
            key={key}
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
                    {delegated ? 'Sub-bot ' : ''}
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
                  <ToolApprovalCard
                    key={request.id}
                    request={request}
                    deciding={state.deciding}
                    delegated={delegated}
                  />
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
                    requests[0].conversationId,
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

function ToolApprovalCard({
  request,
  deciding,
  delegated,
}: {
  request: ToolApproval;
  deciding: string[];
  delegated?: boolean;
}) {
  const state = useApprovals();
  return (
    <section className="tool-approval-card" aria-label={`Approval for ${request.toolName}`}>
      <div className="tool-approval-heading">
        <Hand size={18} />
        <strong>
          {delegated ? 'Sub-bot ' : ''}
          {request.botName} wants to use {request.toolName}
        </strong>
      </div>
      <p role="status">Waiting for your approval. This tool has not run.</p>
      {delegated && (
        <p>
          Your bot is waiting for {request.botName}’s response. This permission is for{' '}
          {request.botName}.
        </p>
      )}
      <details>
        <summary>Review tool arguments</summary>
        <pre>{JSON.stringify(request.input, null, 2)}</pre>
      </details>
      <div className="tool-approval-full-access">
        <label>
          <Checkbox
            checked={state.loaded && state.mode === 'full-access'}
            disabled={
              !state.loaded ||
              state.saving ||
              Boolean(request.target && request.target.workspaceId !== state.workspaceId)
            }
            onChange={(event) =>
              void approvalStore.setMode(event.target.checked ? 'full-access' : 'ask-for-approval')
            }
          />
          Enable Full Access Mode
        </label>
        <Tooltip
          label="About Full Access Mode"
          content="Changes the tool approval mode for every bot and conversation in this workspace. Future tools governed by this mode run without asking. Existing pending tool calls still need approval, and explicit confirmations and questions still need your response. Other workspaces are unaffected. You can switch back using the approval mode picker."
        />
      </div>
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
