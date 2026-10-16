import type { AppUpdater } from 'electron-updater';
import type { DesktopUpdateState } from '../shared/contracts';

type Updater = Pick<
  AppUpdater,
  | 'on'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowPrerelease'
  | 'allowDowngrade'
  | 'channel'
  | 'checkForUpdates'
  | 'quitAndInstall'
>;

export class DesktopUpdater {
  private state: DesktopUpdateState;
  private checking = false;
  private restarting = false;
  private startup?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly updater: Updater | undefined,
    currentVersion: string,
    private readonly options: {
      notify: (state: DesktopUpdateState) => void;
      confirmRestart: () => Promise<boolean>;
      prepareQuit: () => Promise<void>;
      disabledReason?: string;
    },
  ) {
    this.state = {
      status: updater ? 'idle' : 'disabled',
      currentVersion,
      ...(updater ? {} : { message: options.disabledReason }),
    };
    if (!updater) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    // CI publishes build-suffixed versions as full GitHub releases. Follow only
    // the published latest release, never drafts or opt-in prereleases.
    updater.channel = 'latest';
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('update-available', ({ version }) =>
      this.set({ status: 'downloading', version, percent: 0 }),
    );
    updater.on('download-progress', ({ percent }) => {
      if (this.state.status === 'downloading')
        this.set({ ...this.state, percent: Math.min(100, Math.max(0, Math.floor(percent))) });
    });
    updater.on('update-not-available', () =>
      this.set({ status: 'idle', message: 'Mukai is up to date.' }),
    );
    updater.on('update-downloaded', ({ version }) => this.set({ status: 'ready', version }));
    updater.on('error', (error) => this.fail(error));
    updater.on('update-cancelled', () => this.fail(new Error('Update download was interrupted.')));
  }

  getState() {
    return { ...this.state };
  }

  start() {
    if (!this.updater || this.startup || this.interval) return;
    this.startup = setTimeout(() => this.check(), 15000);
    this.startup.unref();
    this.interval = setInterval(() => this.check(), 4 * 60 * 60 * 1000);
    this.interval.unref();
  }

  stop() {
    clearTimeout(this.startup);
    clearInterval(this.interval);
    this.startup = undefined;
    this.interval = undefined;
  }

  check() {
    if (
      !this.updater ||
      this.checking ||
      this.restarting ||
      this.state.status === 'ready' ||
      this.state.status === 'installing'
    )
      return this.getState();
    this.checking = true;
    this.set({ status: 'checking' });
    void this.runCheck();
    return this.getState();
  }

  private async runCheck() {
    try {
      const result = await this.updater!.checkForUpdates();
      if (!result) throw new Error('Updates are unavailable for this installation.');
      await result.downloadPromise;
    } catch (error) {
      this.fail(error);
    } finally {
      this.checking = false;
    }
  }

  async restart() {
    if (!this.updater || this.state.status !== 'ready' || this.restarting) return;
    this.restarting = true;
    try {
      if (!(await this.options.confirmRestart())) return;
      this.set({ status: 'installing', version: this.state.version });
      this.stop();
      await this.options.prepareQuit();
      // Silent NSIS update preserves the install location and shortcuts.
      this.updater.quitAndInstall(true, true);
    } catch (error) {
      this.fail(error);
      this.start();
    } finally {
      this.restarting = false;
    }
  }

  private fail(error: unknown) {
    console.error('Mukai update failed:', error);
    this.set({
      status: 'error',
      message: 'Could not update Mukai. Check your connection and retry.',
    });
  }

  private set(next: Omit<DesktopUpdateState, 'currentVersion'>) {
    this.state = { currentVersion: this.state.currentVersion, ...next };
    this.options.notify(this.getState());
  }
}
