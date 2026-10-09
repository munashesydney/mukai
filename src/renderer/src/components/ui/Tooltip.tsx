import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import './Tooltip.css';

/** Keyboard, pointer and touch accessible help, rendered in the browser's top layer. */
export function Tooltip({
  content,
  label = 'More information',
}: {
  content: ReactNode;
  label?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const element = bubble.current;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(310, window.innerWidth - 24);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      const height = element.getBoundingClientRect().height;
      element.style.top = `${rect.bottom + height + 10 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)}px`;
    };
    element.showPopover();
    position();
    const dismiss = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !element.contains(event.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      element.hidePopover();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [open]);
  return (
    <span
      className="tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (document.activeElement !== trigger.current) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="tooltip-trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      {open && (
        <div ref={bubble} id={id} role="tooltip" popover="manual" className="tooltip-bubble">
          {content}
        </div>
      )}
    </span>
  );
}
