import { useContext, useRef, useState, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, Image, LoaderCircle } from 'lucide-react';
import { ArtifactPreview } from './ArtifactPreview';
import { ResponseImageContext } from './responseImageContext';
import { ResponseReferenceContext } from './responseReferenceContext';
import { useGalleryPreviews } from './useGalleryPreviews';
import type { ResponseImage } from './responseImages';

const noImages: ResponseImage[] = [];

export function ResponseImageGallery({
  selected,
  onSelect,
  galleryRef,
  highlighted,
}: {
  selected: string | null;
  onSelect: (key: string) => void;
  galleryRef: RefObject<HTMLDivElement | null>;
  highlighted: boolean;
}) {
  const gallery = useContext(ResponseImageContext);
  const conversationId = useContext(ResponseReferenceContext);
  const previews = useGalleryPreviews(conversationId, gallery?.images || noImages, galleryRef);
  const [open, setOpen] = useState<ResponseImage | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  if (!gallery?.images.length) return null;
  const { images } = gallery;
  const index = Math.max(
    0,
    images.findIndex((image) => image.key === selected),
  );
  const multiple = images.length > 1;
  const openIndex = open ? images.findIndex((image) => image.key === open.key) : -1;
  function stepPreview(position: number) {
    const image = images[position];
    setOpen(image);
    onSelect(image.key);
  }
  function step(direction: number) {
    onSelect(images[Math.max(0, Math.min(images.length - 1, index + direction))].key);
  }
  return (
    <div
      ref={galleryRef}
      className="response-image-gallery"
      role="region"
      aria-label="Images in this reply"
      aria-roledescription={multiple ? 'carousel' : undefined}
      tabIndex={-1}
      data-highlighted={highlighted || undefined}
      onKeyDown={(event) => {
        if (!multiple || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          step(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
      onTouchStart={(event) => {
        touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }}
      onTouchEnd={(event) => {
        if (!touch.current) return;
        const dx = event.changedTouches[0].clientX - touch.current.x;
        const dy = event.changedTouches[0].clientY - touch.current.y;
        touch.current = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          suppressClickUntil.current = Date.now() + 400;
          step(dx > 0 ? -1 : 1);
        }
      }}
      onClickCapture={(event) => {
        if (Date.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onTouchCancel={() => {
        touch.current = null;
      }}
    >
      <div className="response-gallery-stage">
        {images.map((image, position) => (
          <div
            className="response-gallery-slide"
            key={image.key}
            hidden={Math.abs(position - index) > 1}
            data-position={position === index ? 'active' : position < index ? 'previous' : 'next'}
            role="group"
            aria-roledescription={multiple ? 'slide' : undefined}
            aria-label={`${position + 1} of ${images.length}: ${image.label}`}
          >
            <button
              type="button"
              className="response-image-button"
              aria-label={position === index ? `Preview ${image.label}` : `Show ${image.label}`}
              onClick={() => (position === index ? setOpen(image) : onSelect(image.key))}
            >
              {previews.get(image.key)?.url ? (
                <img src={previews.get(image.key)!.url} alt={image.label} />
              ) : previews.get(image.key)?.error ? (
                <Image size={24} aria-label="Image unavailable" />
              ) : (
                <LoaderCircle size={20} className="is-spinning" aria-label="Loading image" />
              )}
            </button>
          </div>
        ))}
      </div>
      {multiple && (
        <>
          <div className="response-gallery-controls">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous image"
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span
              className="response-gallery-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {index + 1} / {images.length}
            </span>
            <div className="response-gallery-dots" aria-label="Choose an image">
              {images.map((image, position) => (
                <button
                  type="button"
                  key={image.key}
                  aria-label={`Show image ${position + 1}`}
                  aria-current={position === index ? 'true' : undefined}
                  onClick={() => onSelect(image.key)}
                />
              ))}
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Next image"
              disabled={index === images.length - 1}
              onClick={() => step(1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="response-gallery-thumbnails" aria-label="Image thumbnails">
            {images.map((image, position) => (
              <button
                type="button"
                key={image.key}
                aria-label={`Select ${image.label}`}
                aria-pressed={position === index}
                onClick={() => onSelect(image.key)}
              >
                {previews.get(image.key)?.url ? (
                  <img src={previews.get(image.key)!.url} alt="" />
                ) : (
                  <Image size={18} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {previews.get(images[index].key)?.error && (
        <p className="ai-alert" role="alert">
          {previews.get(images[index].key)!.error}
        </p>
      )}
      {open && conversationId && (
        <ArtifactPreview
          key={open.key}
          reference={{ conversationId, href: open.href, name: open.label }}
          navigation={{
            index: openIndex,
            total: images.length,
            previous: openIndex > 0 ? () => stepPreview(openIndex - 1) : undefined,
            next: openIndex < images.length - 1 ? () => stepPreview(openIndex + 1) : undefined,
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
