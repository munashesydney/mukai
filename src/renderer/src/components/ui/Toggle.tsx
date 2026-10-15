import type { InputHTMLAttributes } from 'react';
import './Toggle.css';

/** A native checkbox with switch semantics; wrap in a label or provide aria-label. */
export function Toggle({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return (
    <input {...props} type="checkbox" role="switch" className={`toggle-control ${className}`} />
  );
}
