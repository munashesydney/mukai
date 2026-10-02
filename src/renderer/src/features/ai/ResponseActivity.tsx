import { Brain, Check, FileText, LoaderCircle, CircleAlert } from 'lucide-react';
import type { ChatMessage } from '../../../../shared/ai';

export function ResponseActivity({ message }: { message: ChatMessage }) {
  return (
    <div className="ai-response-activity">
      {message.reasoning && (
        <details
          className="reasoning-card"
          open={message.status === 'streaming' ? true : undefined}
        >
          <summary>
            <Brain size={15} />
            <span>{message.status === 'streaming' ? 'Thinking' : 'Reasoning'}</span>
            <small>From the model</small>
          </summary>
          <div className="reasoning-content">{message.reasoning}</div>
        </details>
      )}
      {!!message.activity?.length && (
        <div className="tool-activity-list" aria-label="File operations">
          {message.activity.map((activity) => (
            <details
              key={activity.id}
              className={`tool-activity tool-activity--${activity.status}`}
            >
              <summary>
                <FileText size={14} />
                <span>File Operations</span>
                <code>{activity.action}</code>
                <span className="tool-path" title={activity.path}>
                  {activity.path}
                </span>
                {activity.status === 'running' ? (
                  <LoaderCircle size={13} className="is-spinning" />
                ) : activity.status === 'complete' ? (
                  <Check size={13} />
                ) : (
                  <CircleAlert size={13} />
                )}
              </summary>
              <p>{activity.summary || 'Working in your workspace folder…'}</p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
