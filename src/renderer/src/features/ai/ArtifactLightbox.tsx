import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Download, Minus, Plus, X } from 'lucide-react';
import './ArtifactLightbox.css';

export interface ArtifactNavigation {
  index: number;
  total: number;
  previous?: () => void;
  next?: () => void;
}

export function ArtifactLightbox({
  title,
  url,
  downloadName = title,
  image,
  navigation,
  onClose,
  children,
}: {
  title: string;
  url?: string;
  downloadName?: string;
  image?: { url: string; onError: () => void };
  navigation?: ArtifactNavigation;
  onClose: () => void;
  children?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="artifact-lightbox"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.target instanceof HTMLMediaElement
        )
          return;
        const step =
          event.key === 'ArrowLeft'
            ? navigation?.previous
            : event.key === 'ArrowRight'
              ? navigation?.next
              : undefined;
        if (step) {
          event.preventDefault();
          step();
        }
      }}
    >
      <header className="artifact-lightbox-heading">
        <h2 id={titleId} title={title}>
          {title}
        </h2>
        {navigation && navigation.total > 1 && (
          <span>
            {navigation.index + 1} / {navigation.total}
          </span>
        )}
      </header>
      <div className="artifact-lightbox-actions">
        {url && (
          <a
            className="artifact-lightbox-button"
            href={url}
            download={downloadName}
            aria-label="Download"
            title="Download"
          >
            <Download size={19} />
          </a>
        )}
        <button
          type="button"
          className="artifact-lightbox-button"
          onClick={onClose}
          aria-label="Close dialog"
          title="Close"
        >
          <X size={20} />
        </button>
      </div>
      <div
        className="artifact-lightbox-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {image ? <ZoomableImage key={image.url} image={image} name={title} /> : children}
      </div>
      {navigation && navigation.total > 1 && (
        <>
          <button
            type="button"
            className="artifact-lightbox-button artifact-lightbox-previous"
            aria-label="Previous artifact"
            disabled={!navigation.previous}
            onClick={navigation.previous}
          >
            <ArrowLeft size={21} />
          </button>
          <button
            type="button"
            className="artifact-lightbox-button artifact-lightbox-next"
            aria-label="Next artifact"
            disabled={!navigation.next}
            onClick={navigation.next}
          >
            <ArrowRight size={21} />
          </button>
        </>
      )}
    </dialog>,
    document.body,
  );
}

function ZoomableImage({
  image,
  name,
}: {
  image: { url: string; onError: () => void };
  name: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  function changeZoom(value: number) {
    setZoom(Math.max(0.25, Math.min(3, value)));
    setPan({ x: 0, y: 0 });
  }
  return (
    <>
      <img
        className="artifact-image-preview artifact-lightbox-image"
        src={image.url}
        alt={name}
        draggable={false}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          cursor: zoom > 1 ? 'grab' : undefined,
          touchAction: zoom > 1 ? 'none' : undefined,
        }}
        onError={image.onError}
        onPointerDown={(event) => {
          if (zoom <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setPan({
              x: drag.current.panX + event.clientX - drag.current.x,
              y: drag.current.panY + event.clientY - drag.current.y,
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <div className="artifact-lightbox-zoom" aria-label="Image zoom">
        <button
          type="button"
          className="artifact-lightbox-button"
          aria-label="Zoom out"
          disabled={zoom <= 0.25}
          onClick={() => changeZoom(zoom - 0.25)}
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          className="artifact-lightbox-zoom-value"
          aria-label="Reset zoom"
          title="Reset zoom"
          onClick={() => changeZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="artifact-lightbox-button"
          aria-label="Zoom in"
          disabled={zoom >= 3}
          onClick={() => changeZoom(zoom + 0.25)}
        >
          <Plus size={17} />
        </button>
      </div>
    </>
  );
}
