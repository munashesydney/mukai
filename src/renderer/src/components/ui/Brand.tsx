export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <img className="brand-logo" src="./mukai-logo.png" alt={compact ? 'Mukai' : ''} />
      {!compact && (
        <span>
          mukai<span className="brand-period">.</span>
        </span>
      )}
    </span>
  );
}
