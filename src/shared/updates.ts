import type { DesktopUpdateState } from './contracts';

/** Both hosts expose the same update controls to the renderer. */
export interface UpdateController {
  getState(): DesktopUpdateState;
  check(): DesktopUpdateState;
  setAutomaticUpdates(enabled: boolean): DesktopUpdateState;
  restart(): Promise<void>;
}
