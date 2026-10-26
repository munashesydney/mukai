import { useEffect, useState } from 'react';
import type { DesktopUpdateState } from '../../../../shared/contracts';
import { updateService } from '../../services/updateService';

export function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    const bridge = updateService;
    let active = true;
    let receivedEvent = false;
    const remove = bridge.onUpdateState((next) => {
      receivedEvent = true;
      if (active) setState(next);
    });
    void bridge
      .getUpdateState()
      .then((next) => {
        if (active && !receivedEvent) setState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
      remove();
    };
  }, []);
  return state;
}
