import { useEffect, useState } from 'react';
import type { DesktopUpdateState } from '../../../../shared/contracts';

export function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    const bridge = window.mukai;
    if (!bridge?.getUpdateState) return;
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
