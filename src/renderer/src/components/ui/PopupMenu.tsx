import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Shared floating surface, focus management and keyboard behavior for rich pickers. */
export function PopupMenu({
  label,
  title,
  footer,
  trigger,
  children,
  placement = 'bottom',
  className = '',
  menuClassName = '',
  buttonClassName = '',
  disabled = false,
}: {
  label: string;
  title: string;
  footer?: ReactNode;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'top' | 'bottom';
  className?: string;
  menuClassName?: string;
  buttonClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const expanded = open && !disabled;
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  useLayoutEffect(() => {
    const element = popup.current;
    if (!expanded || !element) return;
    function position() {
      const bounds = button.current?.getBoundingClientRect();
      if (!bounds || !element) return;
      const above = bounds.top - 16,
        below = window.innerHeight - bounds.bottom - 16;
      const upward =
        placement === 'top' ? above >= 180 || above > below : below < 180 && above > below;
      const width = Math.min(370, window.innerWidth - 24);
      Object.assign(element.style, {
        width: `${width}px`,
        left: `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`,
        top: upward ? 'auto' : `${bounds.bottom + 9}px`,
        bottom: upward ? `${window.innerHeight - bounds.top + 9}px` : 'auto',
        maxHeight: `${Math.max(80, upward ? above : below)}px`,
      });
    }
    position();
    element.showPopover();
    (
      element.querySelector<HTMLButtonElement>('[aria-checked="true"]') ||
      element.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
    )?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) position();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', position);
    return () => {
      element.hidePopover();
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', position);
    };
  }, [expanded, placement]);
  return (
    <div
      ref={root}
      className={className}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (expanded && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [
            ...(popup.current?.querySelectorAll<HTMLButtonElement>(
              '[role^="menuitem"]:not(:disabled)',
            ) || []),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!expanded && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {expanded && (
        <div
          ref={popup}
          id={id}
          role="menu"
          aria-label={title}
          popover="manual"
          className={`popup-menu ${menuClassName}`}
        >
          <p>{title}</p>
          {children(close)}
          {footer && <small>{footer}</small>}
        </div>
      )}
    </div>
  );
}
