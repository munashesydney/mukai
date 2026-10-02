import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, FileText, LoaderCircle } from 'lucide-react';
import type { Attachment, FileArtifact } from '../../../../shared/ai';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';
import { Modal } from '../../components/ui/Modal';
import { AttachmentCard } from './AttachmentCard';

export function ArtifactsView({
  botId,
  conversationId,
  attachments,
}: {
  botId?: string;
  conversationId?: string;
  attachments: Attachment[];
}) {
  const [files, setFiles] = useState<FileArtifact[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
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
  }, [refresh]);
  return (
    <div className="alternate-view artifacts-view">
      <div className="view-intro">
        <FileText size={24} />
        <span className="artifacts-eyebrow">Artifacts</span>
        <h2>A home for the useful things.</h2>
        <p>Drafts and files shared in this conversation.</p>
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

function ArtifactCard({ artifact }: { artifact: FileArtifact }) {
  const [preview, setPreview] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function open(download = false) {
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
      <article className="file-list-row artifact-row">
        <span className="card-symbol card-symbol--purple">
          <FileText size={24} />
        </span>
        <div className="artifact-row-name">
          <strong>{artifact.name}</strong>
          <small title={artifact.path}>{artifact.path} · Workspace file</small>
        </div>
        <button
          className="icon-button"
          aria-label={`Preview ${artifact.name}`}
          disabled={busy}
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
      {error && (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      )}
      {preview !== null && (
        <Modal title={artifact.name} onClose={() => setPreview(null)}>
          <div className="artifact-preview">
            <p>{artifact.path}</p>
            <pre>{preview}</pre>
          </div>
          <div className="modal-footer">
            <span>Current workspace file</span>
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
