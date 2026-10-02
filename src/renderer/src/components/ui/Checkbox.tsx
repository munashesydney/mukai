import type { InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';

export function Checkbox({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className="checkbox-control">
      <input {...props} type="checkbox" className={`themed-checkbox ${className}`} />
      <Check size={13} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}
