import { useCallback, useEffect, useState } from 'react';
import type { Pursuit } from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
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
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const values = await pursuitService.list(workspaceId);
        if (alive) {
          setPursuits(values);
          setError('');
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [workspaceId]);
  return { pursuits, error, loading, refresh };
}
