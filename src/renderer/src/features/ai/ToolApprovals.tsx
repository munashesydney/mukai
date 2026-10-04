import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronUp, Hand, ShieldAlert } from 'lucide-react';
import { approvalStore, useApprovals } from './approvalStore';
import type { ApprovalMode } from '../../../../shared/approvals';

const choices = [
  {
    mode: 'ask-for-approval',
    label: 'Ask for approval',
    description: 'Ask before every workspace and custom tool call',
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const selected = choices.find((choice) => choice.mode === state.mode)!;
  const Icon = selected.icon;
  useEffect(() => {
    if (!open) return;
    options.current[choices.findIndex((choice) => choice.mode === state.mode)]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, state.mode]);
  function choose(mode: ApprovalMode) {
    setOpen(false);
    trigger.current?.focus();
    void approvalStore.setMode(mode);
  }
  return (
    <div
      className="approval-mode-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className={`approval-mode-trigger ${state.mode}`}
        aria-label="Tool approval mode for all bots"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={!state.loaded || state.saving}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon size={15} />
        <span>
          {state.saving ? 'Saving…' : state.loaded ? selected.label : 'Loading permissions…'}
        </span>
        <ChevronUp size={12} />
      </button>
      {open && (
        <div
          id={id}
          className="approval-mode-menu"
          role="menu"
          aria-label="How should Mukai tools be approved?"
        >
          <p>How should Mukai tools be approved?</p>
          {choices.map((choice, index) => {
            const ChoiceIcon = choice.icon;
            return (
              <button
                key={choice.mode}
                type="button"
                role="menuitemradio"
                aria-checked={state.mode === choice.mode}
                className={choice.mode}
                ref={(element) => {
                  options.current[index] = element;
                }}
                onClick={() => choose(choice.mode)}
                onKeyDown={(event) => {
                  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? choices.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
                            choices.length;
                    options.current[next]?.focus();
                  }
                }}
              >
                <ChoiceIcon size={18} />
                <span>
                  <strong>{choice.label}</strong>
                  <small>{choice.description}</small>
                </span>
                {state.mode === choice.mode && <Check size={16} />}
              </button>
            );
          })}
          <small>Applies to all bots and conversations across Mukai.</small>
        </div>
      )}
    </div>
  );
}

/** Includes other chats so scheduled and background bots can always be approved. */
export function ToolApprovalCards({ conversationId }: { conversationId?: string }) {
  const state = useApprovals();
  const requests = [...state.pending].sort(
    (a, b) =>
      Number(b.conversationId === conversationId) - Number(a.conversationId === conversationId),
  );
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
      {requests.map((request) => (
        <section
          className="tool-approval-card"
          key={request.id}
          aria-label={`Approval for ${request.toolName}`}
        >
          <div className="tool-approval-heading">
            <Hand size={18} />
            <strong>
              {request.botName} wants to use {request.toolName}
            </strong>
          </div>
          <p role="status">
            Waiting for your approval
            {conversationId && request.conversationId !== conversationId
              ? ' in another conversation'
              : ''}
            . This tool has not run.
          </p>
          <details>
            <summary>Review tool arguments</summary>
            <pre>{JSON.stringify(request.input, null, 2)}</pre>
          </details>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="button button--small"
              disabled={state.deciding.includes(request.id)}
              onClick={() => void approvalStore.decide(request.id, false)}
            >
              Reject
            </button>
            <button
              type="button"
              className="button button--primary button--small"
              disabled={state.deciding.includes(request.id)}
              onClick={() => void approvalStore.decide(request.id, true)}
            >
              Approve tool call
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
