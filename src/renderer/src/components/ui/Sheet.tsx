import type { ComponentProps } from 'react';
import { Modal } from './Modal';

export function Sheet({ className = '', ...props }: ComponentProps<typeof Modal>) {
  return <Modal {...props} className={`sheet ${className}`} />;
}
