import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, SquarePen, X } from 'lucide-react';
import type { ToolApproval } from '../../../../shared/approvals';
import { approvalStore } from './approvalStore';

export function AskRequestCard({
  request,
  busy,
  navigation,
  onCancel,
  delegated,
}: {
  request: ToolApproval;
  busy: boolean;
  navigation?: ReactNode;
  onCancel?: () => void;
  delegated?: boolean;
}) {
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const question = request.ask;
  if (!question) return null;
  const clarification = question.action === 'clarification';
  const answer = typed.trim() || selected;
  const contentId = `ask-content-${request.id}`;
  return (
    <section
      className="ask-request-card"
      aria-label={clarification ? 'Clarification request' : 'Approval request'}
    >
      <header className="ask-request-header">
        <span>
          {clarification ? 'Question' : 'Approval'} from {delegated ? 'sub-bot ' : ''}
          {request.botName}
        </span>
        <div className="ask-request-controls">
          <button
            type="button"
            className="ask-icon-button"
            aria-label={collapsed ? 'Expand question' : 'Collapse question'}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {onCancel && (
            <button
              type="button"
              className="ask-icon-button"
              aria-label="Stop response"
              title="Stop response"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>
      <form
        aria-labelledby={`ask-question-${request.id}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (clarification && answer && !busy) void approvalStore.answer(request.id, answer);
          if (!clarification && denying && reason.trim() && !busy)
            void approvalStore.decide(request.id, false, reason.trim());
        }}
      >
        <div className="ask-request-scroll" role="region" aria-label="Request details" tabIndex={0}>
          {delegated && (
            <p className="ai-caption">
              Your bot is waiting for {request.botName}’s response. This request is from{' '}
              {request.botName}.
            </p>
          )}
          <p className="ask-question" id={`ask-question-${request.id}`}>
            {question.question}
          </p>
          <div className="ask-request-content" id={contentId} hidden={collapsed}>
            {!clarification && denying && (
              <label className={`ask-answer-field ${reason ? 'is-selected' : ''}`}>
                <span className="ask-option-number" aria-hidden="true">
                  <SquarePen size={12} />
                </span>
                <textarea
                  aria-label="Reason for denying"
                  placeholder="Tell the bot why you’re denying this request…"
                  rows={reason.includes('\n') || reason.length > 100 ? 3 : 1}
                  value={reason}
                  maxLength={16000}
                  autoFocus
                  required
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            )}
            {clarification && (
              <>
                <fieldset className="ask-options" disabled={busy} aria-label="Suggested answers">
                  {question.options?.map((option, index) => (
                    <label
                      className={`ask-option ${selected === option.label && !typed ? 'is-selected' : ''}`}
                      key={option.label}
                    >
                      <input
                        className="visually-hidden"
                        type="radio"
                        name={`ask-option-${request.id}`}
                        checked={selected === option.label && !typed}
                        onChange={() => {
                          setSelected(option.label);
                          setTyped('');
                        }}
                      />
                      <span className="ask-option-number" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="ask-option-copy">
                        <strong>{option.label}</strong>
                        {option.description && (
                          <span className="ask-option-description">{option.description}</span>
                        )}
                        {option.recommended && <span className="ask-recommended">Recommended</span>}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <label className={`ask-answer-field ${typed ? 'is-selected' : ''}`}>
                  <span className="ask-option-number" aria-hidden="true">
                    <SquarePen size={12} />
                  </span>
                  <textarea
                    aria-label="Type your answer"
                    placeholder="Type your answer"
                    rows={typed.includes('\n') || typed.length > 100 ? 3 : 1}
                    value={typed}
                    maxLength={16000}
                    disabled={busy}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      setSelected('');
                    }}
                  />
                </label>
              </>
            )}
          </div>
        </div>
        <footer className="ask-request-footer">
          {navigation || <span className="ask-request-count">1/1</span>}
          <div className="ask-request-actions">
            {clarification ? (
              <>
                <button
                  type="button"
                  className="button button--small"
                  disabled={busy}
                  onClick={() =>
                    void approvalStore.answer(
                      request.id,
                      'I’m skipping this question. Please proceed without an answer.',
                    )
                  }
                >
                  Skip
                </button>
                <button
                  type="submit"
                  className="button button--primary button--small"
                  disabled={busy || !answer}
                >
                  {busy ? 'Sending…' : 'Submit'}
                </button>
              </>
            ) : denying ? (
              <>
                <button
                  type="button"
                  className="button button--small"
                  disabled={busy}
                  onClick={() => setDenying(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button--danger button--small"
                  disabled={busy || !reason.trim()}
                >
                  {busy ? 'Sending…' : 'Deny with reason'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button button--small"
                  disabled={busy}
                  onClick={() => void approvalStore.decide(request.id, false)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={busy}
                  onClick={() => {
                    setDenying(true);
                    setCollapsed(false);
                  }}
                >
                  Deny with reason
                </button>
                <button
                  type="button"
                  className="button button--primary button--small"
                  disabled={busy}
                  onClick={() => void approvalStore.decide(request.id, true)}
                >
                  Approve
                </button>
              </>
            )}
          </div>
        </footer>
      </form>
    </section>
  );
}
