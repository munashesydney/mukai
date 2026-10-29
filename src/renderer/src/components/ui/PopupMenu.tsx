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
  buttonTitle,
  disabled = false,
  role = 'menu',
  width = 370,
  pointer = false,
}: {
  label: string;
  title: string;
  footer?: ReactNode;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'top' | 'bottom' | 'right';
  className?: string;
  menuClassName?: string;
  buttonClassName?: string;
  buttonTitle?: string;
  disabled?: boolean;
  role?: 'menu' | 'dialog';
  width?: number;
  pointer?: boolean;
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
      const popupWidth = Math.min(width, window.innerWidth - 24);
      const sideways =
        placement === 'right' && bounds.right + 9 + popupWidth <= window.innerWidth - 12;
      Object.assign(element.style, {
        width: `${popupWidth}px`,
        left: `${sideways ? bounds.right + 9 : Math.max(12, Math.min(bounds.left, window.innerWidth - popupWidth - 12))}px`,
        top: sideways
          ? `${Math.max(12, Math.min(bounds.top, window.innerHeight - element.offsetHeight - 12))}px`
          : upward
            ? 'auto'
            : `${bounds.bottom + 9}px`,
        bottom: !sideways && upward ? `${window.innerHeight - bounds.top + 9}px` : 'auto',
        maxHeight: `${sideways ? window.innerHeight - 24 : Math.max(80, upward ? above : below)}px`,
      });
      if (pointer) {
        const card = element.getBoundingClientRect();
        element.dataset.pointerSide = sideways ? 'left' : upward ? 'bottom' : 'top';
        element.style.setProperty(
          '--popup-pointer-x',
          `${Math.max(18, Math.min(bounds.left + bounds.width / 2 - card.left, card.width - 18))}px`,
        );
        element.style.setProperty(
          '--popup-pointer-y',
          `${Math.max(18, Math.min(bounds.top + bounds.height / 2 - card.top, card.height - 18))}px`,
        );
      }
    }
    position();
    element.showPopover();
    position();
    (
      element.querySelector<HTMLElement>('[data-popup-autofocus]') ||
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
  }, [expanded, placement, width, pointer]);
  return (
    <div
      ref={root}
      className={className}
      onBlur={(event) => {
        // Focus moving to the document body must not close the menu. On touch
        // (e.g. iPadOS) taps and programmatic focus often fail to land on a
        // button, so activeElement falls back to <body> and relatedTarget is
        // null; a disabled focused action blurring mid-save does the same. The
        // document-level pointerdown handler already dismisses on real taps
        // outside the menu, so keeping the menu open here is safe.
        if (!event.relatedTarget) return;
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          role === 'menu' &&
          expanded &&
          ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        ) {
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
        title={buttonTitle}
        aria-label={label}
        aria-haspopup={role}
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
          role={role}
          aria-label={title}
          popover="manual"
          className={`popup-menu ${pointer ? 'popup-menu--pointer' : ''} ${menuClassName}`}
        >
          <p>{title}</p>
          {children(close)}
          {footer && <small>{footer}</small>}
        </div>
      )}
    </div>
  );
}
