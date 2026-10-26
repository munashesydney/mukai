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
  reference,
  onClose,
}: {
  artifact?: FileArtifact;
  reference?: { conversationId: string; href: string; name: string; line?: number };
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const { id, name, kind, mediaType } = artifact || {
    id: '',
    name: reference?.name || 'File',
    kind: undefined,
    mediaType: undefined,
  };
  const conversationId = reference?.conversationId,
    href = reference?.href;
  const [fileName, setFileName] = useState(name);
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    void (async () => {
      try {
        const source =
          href && conversationId
            ? await artifactService.reference(conversationId, href, false, controller.signal)
            : { blob: await artifactService.blob(id, controller.signal), name };
        const { blob } = source;
        const result = await artifactPreview(blob, { name: source.name, kind, mediaType });
        if (controller.signal.aborted) return;
        setFileName(source.name);
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
  }, [id, name, kind, mediaType, conversationId, href]);
  useEffect(() => {
    if (preview.kind === 'text' && reference?.line)
      document
        .getElementById(`reference-line-${reference.line}`)
        ?.scrollIntoView({ block: 'center' });
  }, [preview, reference?.line]);
  return createPortal(
    <Modal title={fileName} onClose={onClose}>
      <div className="artifact-preview">
        <p>{artifact?.path || reference?.href}</p>
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
            alt={fileName}
            onError={() =>
              setPreview({
                kind: 'error',
                url: preview.url,
                message: 'This image could not be displayed. Download the file to inspect it.',
              })
            }
          />
        ) : (
          <pre>
            {reference?.line
              ? preview.content.split('\n').map((line, index) => (
                  <span
                    className={index + 1 === reference.line ? 'reference-selected-line' : undefined}
                    id={`reference-line-${index + 1}`}
                    key={index}
                  >
                    {line}
                    {'\n'}
                  </span>
                ))
              : preview.content}
          </pre>
        )}
      </div>
      {'url' in preview && (
        <div className="modal-footer">
          <span>{kind === 'image' ? 'Saved screenshot' : 'File'}</span>
          <a className="button" href={preview.url} download={fileName}>
            <Download size={15} /> Download
          </a>
        </div>
      )}
    </Modal>,
    document.body,
  );
}
