import { useState } from 'react';
import { CornerDownRight, ListPlus, Pencil, Trash2 } from 'lucide-react';
import type { ChatState } from '../../models/chat';
import { chatStore } from './chatStore';

export function FollowupQueue({ chatId, state }: { chatId: string; state: ChatState }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const active = [...state.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.status === 'streaming');
  if (!state.followups.length) return null;
  return (
    <div className="followup-queue" aria-label="Pending follow-ups" aria-live="polite">
      {state.followups.map((item) => (
        <div className="followup-row" key={item.id}>
          <ListPlus size={15} className="followup-icon" />
          {editing === item.id ? (
            <div className="followup-edit">
              <textarea
                aria-label="Edit queued message"
                autoFocus
                rows={2}
                maxLength={16000}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="followup-edit-actions">
                <button
                  className="text-button"
                  disabled={state.submittingFollowup || !text.trim()}
                  onClick={async () => {
                    if (
                      await chatStore.followup(chatId, {
                        action: 'edit',
                        id: item.id,
                        text: text.trim(),
                      })
                    )
                      setEditing(null);
                  }}
                >
                  Save
                </button>
                <button className="text-button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="followup-copy">
                <p>{item.text}</p>
                {item.state !== 'queued' && (
                  <span>
                    {item.state === 'steering'
                      ? 'Pending steering · applies at the next safe step'
                      : 'Sending…'}
                  </span>
                )}
                {item.error && <span className="followup-error">{item.error}</span>}
              </div>
              {item.state === 'queued' && (
                <div className="followup-actions">
                  <button
                    className="followup-steer"
                    disabled={
                      state.submittingFollowup ||
                      (state.busy && (!active || active.botId !== item.botId))
                    }
                    title={
                      active
                        ? active.botId === item.botId
                          ? 'Apply this message to the current task'
                          : 'Waiting for this bot to run'
                        : 'Send this follow-up'
                    }
                    onClick={() => {
                      void chatStore.followup(
                        chatId,
                        active
                          ? { action: 'steer', id: item.id, expectedRequestId: active.requestId }
                          : { action: 'send', id: item.id },
                      );
                    }}
                  >
                    <CornerDownRight size={14} />
                    {active ? 'Steer' : 'Send'}
                  </button>
                  <button
                    className="followup-icon-button"
                    aria-label="Edit queued message"
                    disabled={state.submittingFollowup}
                    onClick={() => {
                      setEditing(item.id);
                      setText(item.text);
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="followup-icon-button"
                    aria-label="Delete queued message"
                    disabled={state.submittingFollowup}
                    onClick={() =>
                      void chatStore.followup(chatId, { action: 'delete', id: item.id })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
              {item.state === 'steering' && (
                <button
                  className="followup-icon-button"
                  aria-label="Cancel pending steering"
                  disabled={state.submittingFollowup}
                  onClick={() => void chatStore.followup(chatId, { action: 'delete', id: item.id })}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
