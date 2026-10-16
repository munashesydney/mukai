import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle } from 'lucide-react';
import type { FileArtifact } from '../../../../shared/ai';
import { Modal } from '../../components/ui/Modal';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';
import { artifactPreview } from './artifactPreviewContent';

type Preview =
  | { kind: 'loading' }
  | { kind: 'image'; url: string }
  | { kind: 'text'; content: string; url: string }
  | { kind: 'unavailable'; message: string; url: string }
  | { kind: 'error'; message: string; url?: string };

export function ArtifactPreview({
  artifact,
  onClose,
}: {
  artifact: FileArtifact;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const { id, name, kind, mediaType } = artifact;
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    void (async () => {
      try {
        const blob = await artifactService.blob(id, controller.signal);
        const result = await artifactPreview(blob, { name, kind, mediaType });
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(
          result.kind === 'image' ? new Blob([blob], { type: result.mediaType }) : blob,
        );
        setPreview({ ...result, url });
      } catch (error) {
        if (!controller.signal.aborted) setPreview({ kind: 'error', message: errorText(error) });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, name, kind, mediaType]);
  return createPortal(
    <Modal title={artifact.name} onClose={onClose}>
      <div className="artifact-preview">
        <p>{artifact.path}</p>
        {preview.kind === 'loading' ? (
          <p role="status">
            <LoaderCircle size={18} className="is-spinning" /> Loading file…
          </p>
        ) : preview.kind === 'error' ? (
          <p className="ai-alert" role="alert">
            {preview.message}
          </p>
        ) : preview.kind === 'unavailable' ? (
          <p role="status">{preview.message}</p>
        ) : preview.kind === 'image' ? (
          <img
            className="artifact-image-preview"
            src={preview.url}
            alt={artifact.name}
            onError={() =>
              setPreview({
                kind: 'error',
                url: preview.url,
                message: 'This image could not be displayed. Download the file to inspect it.',
              })
            }
          />
        ) : (
          <pre>{preview.content}</pre>
        )}
      </div>
      {'url' in preview && (
        <div className="modal-footer">
          <span>{artifact.kind === 'image' ? 'Saved screenshot' : 'Workspace file'}</span>
          <a className="button" href={preview.url} download={artifact.name}>
            <Download size={15} /> Download
          </a>
        </div>
      )}
    </Modal>,
    document.body,
  );
}
