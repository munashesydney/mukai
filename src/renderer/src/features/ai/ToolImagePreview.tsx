import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle } from 'lucide-react';
import type { ChatActivity, ChatMessage } from '../../../../shared/ai';
import { Modal } from '../../components/ui/Modal';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';

export function ToolImagePreview({
  activity,
  message,
  artifactId,
  onClose,
}: {
  activity: ChatActivity;
  message: ChatMessage;
  artifactId: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const name = artifactId ? 'Screenshot' : activity.path.split(/[\\/]/).at(-1) || 'Image';
  useEffect(() => {
    let disposed = false,
      objectUrl = '';
    const load = artifactId
      ? artifactService.blob(artifactId)
      : artifactService.activityImage(
          message.conversationId || 'bot-' + message.botId,
          message.id,
          activity.id,
        );
    void load
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((failure) => {
        if (!disposed) setError(errorText(failure));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, activity.id, message.id, message.conversationId, message.botId]);
  return createPortal(
    <Modal title={name} onClose={onClose}>
      <div className="artifact-preview">
        {activity.path && <p>{activity.path}</p>}
        {error ? (
          <p className="ai-alert" role="alert">
            {error}
          </p>
        ) : url ? (
          <img className="artifact-image-preview" src={url} alt={name} />
        ) : (
          <p role="status">
            <LoaderCircle size={18} className="is-spinning" /> Loading image&#8230;
          </p>
        )}
      </div>
      {url && (
        <div className="modal-footer">
          <span>{artifactId ? 'Saved screenshot' : 'Current image file'}</span>
          <a
            className="button"
            href={url}
            download={artifactId ? 'screenshot.png' : name.replace(/\.[^.]+$/, '') + '.png'}
          >
            <Download size={15} /> Download
          </a>
        </div>
      )}
    </Modal>,
    document.body,
  );
}
