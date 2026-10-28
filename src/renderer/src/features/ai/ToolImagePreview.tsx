import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ChatActivity, ChatMessage } from '../../../../shared/ai';
import { ArtifactLightbox } from './ArtifactLightbox';
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
  return (
    <ArtifactLightbox
      title={name}
      url={url || undefined}
      downloadName={artifactId ? 'screenshot.png' : name.replace(/\.[^.]+$/, '') + '.png'}
      image={
        url && !error
          ? {
              url,
              onError: () =>
                setError('This image could not be displayed. Download it to inspect it.'),
            }
          : undefined
      }
      onClose={onClose}
    >
      <div className="artifact-preview">
        {error ? (
          <p className="ai-alert" role="alert">
            {error}
          </p>
        ) : !url ? (
          <p role="status">
            <LoaderCircle size={18} className="is-spinning" /> Loading image&#8230;
          </p>
        ) : null}
      </div>
    </ArtifactLightbox>
  );
}
