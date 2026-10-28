import { CornerDownRight } from 'lucide-react';
import type { ChatMessage } from '../../../../shared/ai';
import { Avatar } from '../../components/ui/Avatar';
import { MessageMarkdown } from './MessageMarkdown';
import { AttachmentCard } from './AttachmentCard';

export function SteeringMessages({
  message,
  collapsed,
}: {
  message: ChatMessage;
  collapsed: boolean;
}) {
  if (!collapsed || message.role !== 'assistant') return null;
  return (
    <>
      {(message.parts || [])
        .filter((part) => part.type === 'steering')
        .map((part) => {
          const createdAt = part.createdAt || message.createdAt;
          return (
            <article className="ai-message ai-message--user ai-message--steering" key={part.id}>
              <Avatar person="munashe" size="sm" />
              <div className="ai-message-body">
                <div className="ai-message-meta">
                  <strong>You</strong>
                  <time dateTime={createdAt}>
                    {new Date(createdAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                  <CornerDownRight
                    size={13}
                    className="steering-message-icon"
                    role="img"
                    aria-label="Steered this task"
                  >
                    <title>Steered this task</title>
                  </CornerDownRight>
                </div>
                <MessageMarkdown text={part.text} />
                {!!part.attachments?.length && (
                  <div className="ai-attachments">
                    {part.attachments.map((file) => (
                      <AttachmentCard key={file.id} attachment={file} />
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
    </>
  );
}
