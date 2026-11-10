import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageCirclePlus } from 'lucide-react';
import './TextSelectionReference.css';

export function TextSelectionReference({
  children,
  botName,
  onAsk,
}: {
  children: ReactNode;
  botName: string;
  onAsk: (text: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const clear = () => setSelected(null);
    const read = () => {
      const selection = window.getSelection();
      const element = root.current;
      if (
        !element ||
        !selection ||
        selection.isCollapsed ||
        !selection.rangeCount ||
        !element.contains(selection.anchorNode) ||
        !element.contains(selection.focusNode)
      ) {
        clear();
        return;
      }
      const text = selection.toString().trim();
      if (!text) return clear();
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSelected({
        text,
        x: Math.max(90, Math.min(window.innerWidth - 90, rect.left + rect.width / 2)),
        y: Math.max(8, rect.top - 42),
      });
    };
    document.addEventListener('selectionchange', read);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return (
    <div ref={root}>
      {children}
      {selected &&
        createPortal(
          <button
            type="button"
            className="ask-selection"
            style={{ left: selected.x, top: selected.y }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onAsk(selected.text);
              window.getSelection()?.removeAllRanges();
              setSelected(null);
            }}
          >
            <MessageCirclePlus size={14} />
            Ask {botName}
          </button>,
          document.body,
        )}
    </div>
  );
}
