import { useState } from 'react';
import { Hand, MessageCircleQuestion } from 'lucide-react';
import type { ToolApproval } from '../../../../shared/approvals';
import { approvalStore } from './approvalStore';

export function AskRequestCard({ request, busy }: { request: ToolApproval; busy: boolean }) {
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');
  const question = request.ask;
  if (!question) return null;
  const clarification = question.action === 'clarification';
  const Icon = clarification ? MessageCircleQuestion : Hand;
  const answer = typed.trim() || selected;
  return (
    <section
      className="tool-approval-card ask-request-card"
      aria-label={clarification ? 'Clarification request' : 'Approval request'}
    >
      <div className="tool-approval-heading">
        <Icon size={18} />
        <strong>
          {request.botName} {clarification ? 'has a question' : 'asks for approval'}
        </strong>
      </div>
      <p className="ask-question" id={`ask-question-${request.id}`}>
        {question.question}
      </p>
      {clarification ? (
        <form
          aria-labelledby={`ask-question-${request.id}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (answer && !busy) void approvalStore.answer(request.id, answer);
          }}
        >
          <fieldset className="ask-options" disabled={busy} aria-label="Suggested answers">
            {question.options?.map((option) => (
              <label
                className={`ask-option ${selected === option.label && !typed ? 'is-selected' : ''}`}
                key={option.label}
              >
                <input
                  type="radio"
                  name={`ask-option-${request.id}`}
                  checked={selected === option.label && !typed}
                  onChange={() => {
                    setSelected(option.label);
                    setTyped('');
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
                {option.recommended && <span className="ask-recommended">Recommended</span>}
              </label>
            ))}
          </fieldset>
          <label className="ask-answer-field">
            Your answer
            <textarea
              aria-label="Type your answer"
              placeholder="Or write your own answer…"
              value={typed}
              maxLength={16000}
              disabled={busy}
              onChange={(event) => {
                setTyped(event.target.value);
                setSelected('');
              }}
            />
          </label>
          <div className="tool-approval-actions">
            <button
              type="submit"
              className="button button--primary button--small"
              disabled={busy || !answer}
            >
              {busy ? 'Sending…' : 'Submit answer'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p role="status">Waiting for your decision.</p>
          <div className="tool-approval-actions">
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
              className="button button--primary button--small"
              disabled={busy}
              onClick={() => void approvalStore.decide(request.id, true)}
            >
              Approve
            </button>
          </div>
        </>
      )}
    </section>
  );
}
