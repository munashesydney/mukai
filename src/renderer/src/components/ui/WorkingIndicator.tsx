export function WorkingIndicator({ label = 'AI is working' }: { label?: string }) {
  return (
    <span className="bot-conversation-working" role="status" aria-label={label}>
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
