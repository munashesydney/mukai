import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';

/** A confirmation presentation of the app's shared modal, including nested sheet actions. */
export function ConfirmationModal({
  title,
  children,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <Modal title={title} className="confirmation-modal" dismissible={!busy} onClose={onClose}>
      <div className="bot-editor-body confirmation-body">
        <div>{children}</div>
        {error && (
          <p className="ai-alert" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--danger"
          disabled={busy}
          aria-busy={busy}
          onClick={onConfirm}
        >
          {busy ? 'Updating…' : confirmLabel}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
