import { useCallback, useEffect, useState } from 'react';
import type { PursuitDetail } from '../../../../shared/pursuits';
import { startPoll } from '../../services/poll';
import { pursuitService } from '../../services/pursuitService';
import { errorText } from '../../utils/errors';

export function usePursuitDetail(id?: string) {
  const [detail, setDetail] = useState<PursuitDetail>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const refresh = useCallback(async (pursuitId: string) => {
    const next = await pursuitService.detail(pursuitId);
    setDetail(next);
    setFailure(undefined);
    return next;
  }, []);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let previous: PursuitDetail | undefined;
    const poll = startPoll(
      async () => {
        try {
          const next = await pursuitService.detail(id);
          if (!alive) return false;
          setDetail(next);
          setFailure(undefined);
          const changed = previous !== next;
          previous = next;
          return changed;
        } catch (error) {
          if (alive) setFailure({ id, message: errorText(error) });
          return false;
        }
      },
      { interval: 2000, maxInterval: 8000 },
    );
    return () => {
      alive = false;
      poll.stop();
    };
  }, [id]);
  return {
    detail: detail?.pursuit.id === id ? detail : undefined,
    error: failure?.id === id ? failure?.message : undefined,
    refresh,
  };
}
