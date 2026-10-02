import { useEffect, useState } from 'react';
import { Download, FileText, LoaderCircle, X } from 'lucide-react';
import type { Attachment } from '../../../../shared/ai';
import { apiFetch, errorText } from './api';

export function AttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (attachment.kind !== 'image') return;
    let disposed = false,
      objectUrl = '';
    void apiFetch(`/attachments/${attachment.id}`)
      .then((response) => response.blob())
      .then((blob) => {
        if (!disposed) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((error) => {
        if (!disposed) setError(errorText(error));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.kind]);
  async function download() {
    setBusy(true);
    setError('');
    try {
      const blob = await (await apiFetch(`/attachments/${attachment.id}`)).blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = attachment.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`ai-attachment ${attachment.kind === 'image' ? 'ai-attachment--image' : ''}`}>
      {attachment.kind === 'image' &&
        (url ? (
          <img src={url} alt={attachment.name} />
        ) : (
          <div className="attachment-preview-loading">
            {error ? 'Preview unavailable' : <LoaderCircle size={20} className="is-spinning" />}
          </div>
        ))}
      <div className="attachment-card-info">
        <FileText size={16} />
        <div>
          <strong title={attachment.name}>{attachment.name}</strong>
          <small>
            {(attachment.size / 1024).toFixed(1)} KB ·{' '}
            {attachment.kind === 'image' ? 'Image' : 'Extracted text'}
          </small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={`Download ${attachment.name}`}
          disabled={busy}
          onClick={() => void download()}
        >
          <Download size={16} />
        </button>
        {onRemove && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${attachment.name}`}
            onClick={onRemove}
          >
            <X size={15} />
          </button>
        )}
      </div>
      {attachment.warning && <p className="attachment-warning">{attachment.warning}</p>}
      {error && (
        <p className="attachment-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
