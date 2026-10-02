import { useRef, useState } from 'react';
import { Plus, Send, Smile, Paperclip, X } from 'lucide-react';
import { IconButton } from '../../components/ui/IconButton';

export function Composer({
  placeholder,
  onSend,
}: {
  placeholder: string;
  onSend: (text: string, attachment?: string) => void;
}) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<string>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  function send() {
    if (!text.trim() && !attachment) return;
    onSend(text.trim(), attachment);
    setText('');
    setAttachment(undefined);
    input.current?.focus();
  }
  return (
    <div className="composer-area">
      <div className="composer">
        {attachment && (
          <div className="composer-attachment">
            <Paperclip size={14} />
            <span>{attachment}</span>
            <IconButton label="Remove attachment" onClick={() => setAttachment(undefined)}>
              <X size={13} />
            </IconButton>
          </div>
        )}
        <textarea
          ref={input}
          rows={2}
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          maxLength={10000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-actions">
            <IconButton
              label="Attach a file"
              className="composer-plus"
              onClick={() => file.current?.click()}
            >
              <Plus size={18} />
            </IconButton>
            <IconButton
              label="Add an emoji"
              onClick={() => setEmojiOpen(!emojiOpen)}
              aria-expanded={emojiOpen}
            >
              <Smile size={18} />
            </IconButton>
          </div>
          <button
            className="send-button"
            onClick={send}
            disabled={!text.trim() && !attachment}
            aria-label="Send message"
          >
            <Send size={16} />
            <span>Send</span>
          </button>
        </div>
        {emojiOpen && (
          <div className="emoji-picker">
            {['👋', '🚀', '👌', '✨', '💡', '🙌', '❤️', '😊'].map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  setText(text + emoji);
                  setEmojiOpen(false);
                  input.current?.focus();
                }}
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        <input
          ref={file}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          onChange={(event) => {
            setAttachment(event.target.files?.[0]?.name);
            event.target.value = '';
          }}
        />
      </div>
      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line
        </span>
      </div>
    </div>
  );
}
