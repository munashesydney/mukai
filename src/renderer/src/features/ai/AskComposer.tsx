import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AskRequestCard } from './AskRequestCard';
import { useApprovals } from './approvalStore';

// Every conversation surface uses the same temporary replacement for its composer.
export function AskComposer({
  conversationId,
  onCancel,
  children,
}: {
  conversationId: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const state = useApprovals();
  const [selectedId, setSelectedId] = useState<string>();
  const requests = state.pending.filter(
    (request) => request.conversationId === conversationId && request.ask,
  );
  if (!requests.length) return children;
  const index = Math.max(
    0,
    requests.findIndex((request) => request.id === selectedId),
  );
  return (
    <div className="ask-composer">
      {requests.map((request, itemIndex) => (
        <div key={request.id} hidden={index !== itemIndex}>
          <AskRequestCard
            request={request}
            busy={state.deciding.includes(request.id)}
            onCancel={onCancel}
            navigation={
              <nav className="ask-request-navigation" aria-label="Pending questions">
                <button
                  type="button"
                  className="ask-icon-button"
                  aria-label="Previous question"
                  disabled={index === 0}
                  onClick={() => setSelectedId(requests[index - 1].id)}
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="ask-request-count" aria-live="polite">
                  {index + 1}/{requests.length}
                </span>
                <button
                  type="button"
                  className="ask-icon-button"
                  aria-label="Next question"
                  disabled={index === requests.length - 1}
                  onClick={() => setSelectedId(requests[index + 1].id)}
                >
                  <ChevronRight size={14} />
                </button>
              </nav>
            }
          />
        </div>
      ))}
    </div>
  );
}
