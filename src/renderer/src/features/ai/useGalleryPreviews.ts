import { useEffect, useMemo, useReducer, type RefObject } from 'react';
import { artifactService } from '../../services/artifactService';
import { errorText } from '../../utils/errors';
import type { ResponseImage } from './responseImages';

type Preview = { controller: AbortController; url?: string; error?: string };

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
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        for (const image of images) {
          if (cache.previews.has(image.key)) continue;
          const preview: Preview = { controller: new AbortController() };
          cache.previews.set(image.key, preview);
          void artifactService
            .reference(owner, image.href, true, preview.controller.signal)
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
