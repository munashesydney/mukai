import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const expanded = open && !disabled && options.length > 0;
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((i) => i >= 0);
  const activeIndex = enabled.includes(active) ? active : (enabled[0] ?? -1);

  function show(index = selected) {
    setActive(enabled.includes(index) ? index : (enabled[0] ?? -1));
    search.current = { text: '', time: 0 };
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    const element = popup.current;
    if (!expanded || !element) return;
    function position() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds || !element) return;
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upward = below < 180 && above > below;
      const width = Math.min(bounds.width, window.innerWidth - 16);
      Object.assign(element.style, {
        width: `${width}px`,
        left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`,
        top: upward ? 'auto' : `${bounds.bottom + 5}px`,
        bottom: upward ? `${window.innerHeight - bounds.top + 5}px` : 'auto',
        maxHeight: `${Math.max(40, Math.min(320, upward ? above : below))}px`,
      });
    }
    position();
    element.showPopover();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && element?.contains(event.target)) return;
      position();
    }
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', scroll, true);
    return () => {
      element.hidePopover();
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [expanded]);
  useLayoutEffect(() => {
    if (expanded) popup.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [expanded, activeIndex]);

  return (
    <span className={`dropdown ${className}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dropdown-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={id}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        disabled={disabled || !enabled.length}
        onClick={() => (expanded ? setOpen(false) : show())}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'Tab') {
            setOpen(false);
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const direction = event.key === 'ArrowUp' ? -1 : 1;
            const index =
              event.key === 'Home'
                ? enabled[0]
                : event.key === 'End'
                  ? enabled.at(-1)
                  : expanded
                    ? enabled[
                        (enabled.indexOf(activeIndex) + direction + enabled.length) % enabled.length
                      ]
                    : selected;
            if (expanded) setActive(index ?? -1);
            else show(index);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (expanded) choose(activeIndex);
            else show();
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const now = Date.now();
            const char = event.key.toLocaleLowerCase();
            const text = now - search.current.time < 700 ? search.current.text + char : char;
            search.current = { text, time: now };
            const query = [...text].every((letter) => letter === char) ? char : text;
            const start = expanded ? activeIndex : selected;
            const ordered = [
              ...enabled.filter((i) => i > start),
              ...enabled.filter((i) => i <= start),
            ];
            const found = ordered.find((i) =>
              options[i].label.toLocaleLowerCase().startsWith(query),
            );
            if (found !== undefined) {
              setActive(found);
              setOpen(true);
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? 'Choose an option'}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="manual"
        className="dropdown-menu"
        role="listbox"
        aria-label={label}
      >
        {options.map((option, index) => (
          <div
            key={option.value}
            id={`${id}-${index}`}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            className={`dropdown-option ${index === activeIndex ? 'is-active' : ''}`}
            onPointerMove={() => {
              if (!option.disabled) setActive(index);
            }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              choose(index);
            }}
          >
            <span>{option.label}</span>
            {option.value === value && <Check size={14} aria-hidden="true" />}
          </div>
        ))}
      </div>
    </span>
  );
}
