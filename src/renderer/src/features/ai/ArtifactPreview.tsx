import { useEffect, useState } from 'react';
import { ExternalLink, FileText, LoaderCircle } from 'lucide-react';
import type { Attachment, FileArtifact } from '../../../../shared/ai';
import { ArtifactLightbox, type ArtifactNavigation } from './ArtifactLightbox';
import { artifactService } from '../../services/artifactService';
import { attachmentService } from '../../services/attachmentService';
import { errorText } from '../../utils/errors';
import { artifactPreview } from './artifactPreviewContent';

type Preview =
  | { kind: 'loading' }
  | { kind: 'image'; url: string }
  | { kind: 'audio'; url: string }
  | { kind: 'video'; url: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'text'; content: string; url: string }
  | { kind: 'unavailable'; message: string; url: string }
  | { kind: 'error'; message: string; url?: string };

export function ArtifactPreview({
  artifact,
  attachment,
  reference,
  navigation,
  onClose,
}: {
  artifact?: FileArtifact;
  attachment?: Attachment;
  reference?: { conversationId: string; href: string; name: string; line?: number };
  navigation?: ArtifactNavigation;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const { id, name, mediaType } = artifact ||
    attachment || {
      id: '',
      name: reference?.name || 'File',
      mediaType: undefined,
    };
  const kind = artifact?.kind ?? (attachment?.kind === 'image' ? 'image' : undefined);
  const attachmentId = attachment?.id;
  const conversationId = reference?.conversationId,
    href = reference?.href;
  const [fileName, setFileName] = useState(name);
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    void (async () => {
      try {
        const source = attachmentId
          ? { blob: await attachmentService.blob(attachmentId, controller.signal), name }
          : href && conversationId
            ? await artifactService.reference(conversationId, href, false, controller.signal)
            : { blob: await artifactService.blob(id, controller.signal), name };
        const { blob } = source;
        const result = await artifactPreview(blob, { name: source.name, kind, mediaType });
        if (controller.signal.aborted) return;
        setFileName(source.name);
        url = URL.createObjectURL(
          'mediaType' in result ? new Blob([blob], { type: result.mediaType }) : blob,
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
  }, [id, name, kind, mediaType, conversationId, href, attachmentId]);
  useEffect(() => {
    if (preview.kind === 'text' && reference?.line)
      document
        .getElementById(`reference-line-${reference.line}`)
        ?.scrollIntoView({ block: 'center' });
  }, [preview, reference?.line]);
  const url = 'url' in preview ? preview.url : undefined;
  return (
    <ArtifactLightbox
      title={fileName}
      url={url}
      navigation={navigation}
      image={
        preview.kind === 'image'
          ? {
              url: preview.url,
              onError: () =>
                setPreview({
                  kind: 'error',
                  url: preview.url,
                  message: 'This image could not be displayed. Download the file to inspect it.',
                }),
            }
          : undefined
      }
      onClose={onClose}
    >
      <div className="artifact-preview">
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
        ) : preview.kind === 'audio' || preview.kind === 'video' ? (
          <MediaPlayer key={preview.url} kind={preview.kind} url={preview.url} name={fileName} />
        ) : preview.kind === 'pdf' ? (
          <div className="artifact-file-notice">
            <FileText size={36} strokeWidth={1.4} />
            <p role="status">
              {window.mukai
                ? 'Download this PDF, then open it in your browser or PDF viewer.'
                : 'Open this PDF in a new browser tab to read it, or download a copy.'}
            </p>
            {!window.mukai && (
              <a href={preview.url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> Open in browser
              </a>
            )}
          </div>
        ) : preview.kind === 'text' ? (
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
        ) : null}
      </div>
    </ArtifactLightbox>
  );
}

function MediaPlayer({ kind, url, name }: { kind: 'audio' | 'video'; url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const Player = kind === 'audio' ? 'audio' : 'video';
  return (
    <div>
      <Player
        className="artifact-media-preview"
        src={url}
        controls
        preload="metadata"
        playsInline
        aria-label={`Play ${name}`}
        onError={() => setFailed(true)}
      />
      {failed && (
        <p className="artifact-media-message" role="status">
          This {kind} could not be played here. Download it to open it in another player.
        </p>
      )}
    </div>
  );
}
