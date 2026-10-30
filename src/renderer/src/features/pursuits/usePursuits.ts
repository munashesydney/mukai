import { useCallback, useEffect, useState } from 'react';
import type { Pursuit } from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
import { startPoll } from '../../services/poll';
import { errorText } from '../../utils/errors';
export function usePursuits(workspaceId: string) {
  const [pursuits, setPursuits] = useState<Pursuit[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const values = await pursuitService.list(workspaceId);
    setPursuits(values);
    setError('');
  }, [workspaceId]);
  useEffect(() => {
    let alive = true,
      pending = false;
    let previous: string | undefined;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const values = await pursuitService.list(workspaceId);
        const snapshot = JSON.stringify(values);
        const changed = snapshot !== previous;
        previous = snapshot;
        if (alive) {
          if (changed) setPursuits(values);
          setError('');
        }
        return changed;
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    const poll = startPoll(() => load(), { interval: 4000, maxInterval: 12000 });
    return () => {
      alive = false;
      poll.stop();
    };
  }, [workspaceId]);
  return { pursuits, error, loading, refresh };
}
