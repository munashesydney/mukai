export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <svg width="32" height="32" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M7 30V15l13 10 13-10v15"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="7" r="2.7" fill="currentColor" />
      </svg>
      {!compact && (
        <span>
          mukai<span className="brand-period">.</span>
        </span>
      )}
    </span>
  );
}
