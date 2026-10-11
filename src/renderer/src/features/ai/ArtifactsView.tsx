import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, FileText, Image, LoaderCircle } from 'lucide-react';
import type { Attachment, FileArtifact, ChatMessage } from '../../../../shared/ai';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';
import { Modal } from '../../components/ui/Modal';
import { AttachmentCard } from './AttachmentCard';

export function ArtifactsView({
  botId,
  conversationId,
  attachments,
  messages,
}: {
  botId?: string;
  conversationId?: string;
  attachments: Attachment[];
  messages: ChatMessage[];
}) {
  const [files, setFiles] = useState<FileArtifact[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const revision = messages
    .flatMap((message) =>
      (message.activity || [])
        .filter(
          (activity) =>
            activity.status === 'complete' &&
            ['screenshot', 'write_file', 'patch'].includes(activity.action),
        )
        .map((activity) => activity.id),
    )
    .join('|');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(
        await (conversationId
          ? artifactService.forConversation(conversationId)
          : artifactService.list(botId!)),
      );
      setError('');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [botId, conversationId]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  return (
    <div className="alternate-view artifacts-view">
      <div className="view-intro">
        <FileText size={24} />
        <span className="artifacts-eyebrow">Artifacts</span>
        <h2>A home for the useful things.</h2>
        <p>Drafts, files, and screenshots shared in this conversation.</p>
      </div>
      {error && (
        <div className="ai-alert" role="alert">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {loading && (
        <p className="ai-caption">
          <LoaderCircle className="is-spinning" size={15} /> Loading artifacts…
        </p>
      )}
      {files.map((file) => (
        <ArtifactCard key={file.id} artifact={file} />
      ))}
      {!!attachments.length && (
        <div className="ai-attachments artifacts-uploads">
          {attachments.map((file) => (
            <AttachmentCard key={file.id} attachment={file} />
          ))}
        </div>
      )}
      {!loading && !error && !files.length && !attachments.length && (
        <div className="artifacts-empty">
          <p>Nothing here yet.</p>
          <span>Share a file, or ask your bot to create something in your workspace.</span>
        </div>
      )}
    </div>
  );
}

export function ArtifactCard({
  artifact,
  compact = false,
}: {
  artifact: FileArtifact;
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null),
    [imageUrl, setImageUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const isImage = artifact.kind === 'image';
  useEffect(() => {
    if (!isImage) return;
    let disposed = false,
      url = '';
    void artifactService
      .blob(artifact.id)
      .then((blob) => {
        if (disposed) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch((failure) => {
        if (!disposed) setError(errorText(failure));
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id, isImage]);
  async function open(download = false) {
    if (!download && isImage) {
      setPreview(imageUrl);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const blob = await artifactService.blob(artifact.id);
      if (download) {
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = artifact.name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else setPreview(await blob.text());
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {compact ? (
        <button
          className="chat-activity-row"
          disabled={busy || (isImage && !imageUrl)}
          title={artifact.path}
          aria-label={`Preview ${artifact.name}`}
          onClick={() => void open()}
        >
          {isImage ? <Image size={17} /> : <FileText size={17} />}
          <span className="chat-activity-row-copy">
            <strong>{artifact.name}</strong>
            <small>
              {artifact.path === artifact.name
                ? isImage
                  ? 'Saved screenshot'
                  : 'Workspace file'
                : artifact.path}
            </small>
          </span>
          {busy ? (
            <LoaderCircle size={14} className="is-spinning" />
          ) : (
            <Eye size={14} className="chat-activity-row-end" />
          )}
        </button>
      ) : (
        <article className="file-list-row artifact-row">
          {isImage && imageUrl ? (
            <button
              className="artifact-thumbnail"
              aria-label={`Preview ${artifact.name}`}
              onClick={() => setPreview(imageUrl)}
            >
              <img src={imageUrl} alt={artifact.name} />
            </button>
          ) : (
            <span className="card-symbol card-symbol--purple">
              {isImage ? <Image size={24} /> : <FileText size={24} />}
            </span>
          )}
          <div className="artifact-row-name">
            <strong>{artifact.name}</strong>
            <small title={artifact.path}>
              {artifact.path} · {isImage ? 'Screenshot' : 'Workspace file'}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label={`Preview ${artifact.name}`}
            disabled={busy || (isImage && !imageUrl)}
            onClick={() => void open()}
          >
            <Eye size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={`Download ${artifact.name}`}
            disabled={busy}
            onClick={() => void open(true)}
          >
            <Download size={17} />
          </button>
        </article>
      )}
      {error && (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      )}
      {preview !== null && (
        <Modal title={artifact.name} onClose={() => setPreview(null)}>
          <div className="artifact-preview">
            <p>{artifact.path}</p>
            {isImage ? (
              <img className="artifact-image-preview" src={preview} alt={artifact.name} />
            ) : (
              <pre>{preview}</pre>
            )}
          </div>
          <div className="modal-footer">
            <span>{isImage ? 'Saved screenshot' : 'Current workspace file'}</span>
            <button className="button" disabled={busy} onClick={() => void open(true)}>
              <Download size={15} />
              Download
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
