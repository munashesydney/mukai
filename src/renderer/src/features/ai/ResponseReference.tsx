import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, Image, LoaderCircle } from 'lucide-react';
import { parseResponseReference } from '../../../../shared/responseReferences';
import { artifactService } from '../../services/artifactService';
import { ArtifactPreview } from './ArtifactPreview';
import { errorText } from '../../utils/errors';

import { ResponseReferenceContext } from './responseReferenceContext';
import { ResponseImageContext } from './responseImageContext';
import { responseImageKey } from './responseImages';

export function ResponseReference({
  href,
  children,
  image = false,
  label = 'Image',
}: {
  href: string;
  children?: ReactNode;
  image?: boolean;
  label?: string;
}) {
  const conversationId = useContext(ResponseReferenceContext);
  const gallery = useContext(ResponseImageContext);
  const galleryImage = gallery?.images.find((entry) => entry.key === responseImageKey(href));
  const target = parseResponseReference(href);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!image || galleryImage || !conversationId || !anchor.current) return;
    const controller = new AbortController();
    let objectUrl = '',
      started = false;
    const load = () => {
      if (started) return;
      started = true;
      void artifactService
        .reference(conversationId, href, true, controller.signal)
        .then(({ blob }) => {
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorText(error));
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          observer.disconnect();
        }
      },
      { rootMargin: '150px' },
    );
    observer.observe(anchor.current);
    return () => {
      observer.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, href, image, galleryImage]);
  if (!conversationId || !target)
    return <span>{children || label} (file preview unavailable here)</span>;
  const name =
    label !== 'Image'
      ? label
      : target.type === 'file'
        ? target.path.split(/[\\/]/).at(-1)!
        : 'File';
  if (galleryImage && gallery)
    return (
      <span className="response-reference">
        <button
          type="button"
          className="response-file-link response-gallery-link"
          onClick={() => gallery.reveal(galleryImage.key)}
        >
          <Image size={14} aria-hidden="true" />
          {children || label}
        </button>
      </span>
    );
  return (
    <span ref={anchor} className={image ? 'response-reference-image' : 'response-reference'}>
      <button
        type="button"
        className={image ? 'response-image-button' : 'response-file-link'}
        onClick={() => setOpen(true)}
        aria-label={image ? `Preview ${name}` : undefined}
      >
        {image ? (
          url ? (
            <img
              src={url}
              alt={label}
              loading="lazy"
              onError={() =>
                setError('This image could not be displayed. Open the file to see its details.')
              }
            />
          ) : error ? (
            <span>{label}</span>
          ) : (
            <span>
              <LoaderCircle size={16} className="is-spinning" /> {label}
            </span>
          )
        ) : (
          <>
            <FileText size={14} />
            {children || name}
          </>
        )}
      </button>
      {error && (
        <span className="ai-alert" role="alert">
          {error}
        </span>
      )}
      {open && (
        <ArtifactPreview
          reference={{ conversationId, href, name, line: target.line }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
