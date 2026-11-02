import { RotateCcw } from 'lucide-react';

export function RetryResponseButton({
  onRetry,
  disabled = false,
  label = 'Retry response',
  className = 'text-button',
}: {
  onRetry: () => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button className={className} disabled={disabled} onClick={onRetry}>
      <RotateCcw size={13} />
      {label}
    </button>
  );
}
