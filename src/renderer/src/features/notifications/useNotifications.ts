import { useCallback, useEffect, useState } from 'react';
import type { NotificationInbox } from '../../../../shared/notifications';
import { notificationService } from '../../services/notificationService';
import { startPoll } from '../../services/poll';
import { errorText } from '../../utils/errors';

export function useNotifications(workspaceId: string) {
  const [inbox, setInbox] = useState<NotificationInbox>({ items: [], total: 0, unread: 0 });
  const [pages, setPages] = useState(1);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let alive = true,
      pending = false;
    let previous: string | undefined;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const results = await Promise.all(
          Array.from({ length: pages }, (_, index) =>
            notificationService.list(workspaceId, index * 30),
          ),
        );
        if (alive) {
          const items = [
            ...new Map(
              results.flatMap((result) => result.items).map((item) => [item.id, item]),
            ).values(),
          ];
          const next = { ...results[0], items };
          const snapshot = JSON.stringify(next);
          const changed = snapshot !== previous;
          previous = snapshot;
          if (changed) setInbox(next);
          setError('');
          return changed;
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    const poll = startPoll(() => load(), { interval: 3000, maxInterval: 10000 });
    const onFocus = () => poll.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      poll.stop();
      window.removeEventListener('focus', onFocus);
    };
  }, [workspaceId, pages, version]);
  return { ...inbox, loading, error, refresh, loadMore: () => setPages((value) => value + 1) };
}
