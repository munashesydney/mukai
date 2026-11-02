import { useEffect, useMemo, useReducer, type RefObject } from 'react';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';
import type { ResponseImage } from './responseImages';

type Preview = { controller: AbortController; started?: boolean; url?: string; error?: string };

export function useGalleryPreviews(
  conversationId: string | null,
  images: ResponseImage[],
  galleryRef: RefObject<HTMLDivElement | null>,
) {
  const cache = useMemo(
    () => ({ conversationId, previews: new Map<string, Preview>() }),
    [conversationId],
  );
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(
    () => () => {
      cache.previews.forEach((preview) => {
        preview.controller.abort();
        if (preview.url) URL.revokeObjectURL(preview.url);
      });
      cache.previews.clear();
    },
    [cache],
  );
  useEffect(() => {
    const owner = cache.conversationId;
    if (!owner || !galleryRef.current || !images.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          // Cancel queued work off-screen; let active reads finish so revisiting uses the cache.
          for (const image of images) {
            const preview = cache.previews.get(image.key);
            if (!preview || preview.started || preview.url || preview.error) continue;
            preview.controller.abort();
            cache.previews.delete(image.key);
          }
          return;
        }
        for (const image of images) {
          if (cache.previews.has(image.key)) continue;
          const preview: Preview = { controller: new AbortController() };
          cache.previews.set(image.key, preview);
          void artifactService
            .reference(owner, image.href, true, preview.controller.signal, () => {
              preview.started = true;
            })
            .then(({ blob }) => {
              if (preview.controller.signal.aborted) return;
              preview.url = URL.createObjectURL(blob);
              refresh();
            })
            .catch((error) => {
              if (preview.controller.signal.aborted) return;
              preview.error = errorText(error);
              refresh();
            });
        }
      },
      { rootMargin: '150px' },
    );
    observer.observe(galleryRef.current);
    return () => observer.disconnect();
  }, [images, cache, galleryRef]);
  return cache.previews;
}
