import { ChevronDown, MessageSquareQuote } from 'lucide-react';
import { MessageMarkdown } from './MessageMarkdown';
import { splitReference, type MessageReference } from './messageReference';
import './ReferencedMessage.css';

export function ReferencePreview({ reference }: { reference: MessageReference }) {
  return (
    <details className="message-reference">
      <summary>
        <span className="message-reference-heading">
          <MessageSquareQuote size={13} aria-hidden="true" />
          <span>Selection</span>
          <span className="message-reference-source" title={reference.label}>
            {reference.label}
          </span>
          <ChevronDown size={13} className="message-reference-chevron" aria-hidden="true" />
        </span>
        <span className="message-reference-preview">{reference.text}</span>
      </summary>
      <div className="message-reference-full">{reference.text}</div>
    </details>
  );
}

export function ReferencedMessage({ text }: { text: string }) {
  const message = splitReference(text);
  return (
    <div className="referenced-message">
      {message.reference && <ReferencePreview reference={message.reference} />}
      {message.text && <MessageMarkdown text={message.text} />}
    </div>
  );
}
