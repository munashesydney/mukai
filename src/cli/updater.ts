import type { DesktopUpdateState } from '../shared/contracts';
import type { UpdateController } from '../shared/updates';
import {
  activateUpdate,
  compareVersions,
  latestRelease,
  prepareUpdate,
  type Installation,
  type PreparedUpdate,
} from './installation';

export class CliUpdater implements UpdateController {
  private state: DesktopUpdateState;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private prepared?: PreparedUpdate;
  private readonly abort = new AbortController();

  constructor(
    currentVersion: string,
    private readonly host: Installation | undefined,
    private readonly options: {
      saveAutomaticUpdates(enabled: boolean): void;
      restart(root: string): Promise<void>;
      request?: typeof fetch;
    },
  ) {
    this.state = {
      currentVersion,
      automaticUpdates: true,
      status: host ? 'idle' : 'disabled',
      ...(!host
        ? {
            message:
              'CLI updates require an installer-managed release. Re-run the Mukai CLI installer to upgrade this copy.',
          }
        : {}),
    };
  }
  getState() {
    return { ...this.state };
  }
  initialize(enabled: boolean) {
    this.state.automaticUpdates = enabled;
    this.start();
  }
  private start() {
    if (
      !this.host ||
      !this.state.automaticUpdates ||
      this.timer ||
      this.interval ||
      this.abort.signal.aborted
    )
      return;
    this.timer = setTimeout(() => this.check(), 15000).unref();
    this.interval = setInterval(() => this.check(), 4 * 60 * 60 * 1000).unref();
  }
  private stopTimers() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = undefined;
    this.interval = undefined;
  }
  async shutdown() {
    this.stopTimers();
    this.abort.abort();
    await this.pending;
  }
  setAutomaticUpdates(enabled: boolean) {
    if (!this.host) return this.getState();
    this.options.saveAutomaticUpdates(enabled);
    this.state.automaticUpdates = enabled;
    if (enabled) this.start();
    else this.stopTimers();
    return this.getState();
  }
  check() {
    if (
      !this.host ||
      this.pending ||
      this.prepared ||
      this.abort.signal.aborted ||
      this.state.status === 'installing'
    )
      return this.getState();
    this.set({ status: 'checking' });
    this.pending = this.runCheck().finally(() => {
      this.pending = undefined;
    });
    return this.getState();
  }
  private async runCheck() {
    const request: typeof fetch = (input, init) =>
      (this.options.request ?? fetch)(input, {
        ...init,
        signal: AbortSignal.any([this.abort.signal, ...(init?.signal ? [init.signal] : [])]),
      });
    try {
      const release = await latestRelease(this.host!, request);
      if (compareVersions(release.version, this.state.currentVersion) <= 0) {
        this.set({ status: 'idle', message: 'Mukai is up to date.' });
        return;
      }
      this.set({ status: 'downloading', version: release.version, percent: 0 });
      this.prepared = await prepareUpdate(
        this.host!,
        release,
        (percent) => {
          this.set({ status: 'downloading', version: release.version, percent });
        },
        request,
        this.abort.signal,
      );
      this.set({ status: 'ready', version: release.version });
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error);
    }
  }
  async restart() {
    if (!this.host || !this.prepared || this.state.status !== 'ready') return;
    this.set({ status: 'installing', version: this.prepared.version });
    this.stopTimers();
    try {
      const root = await activateUpdate(this.host, this.prepared);
      await this.options.restart(root);
    } catch (error) {
      this.prepared = undefined;
      this.fail(error);
      this.start();
    }
  }
  private fail(error: unknown) {
    console.error('Mukai CLI update failed:', error);
    this.set({
      status: 'error',
      message:
        error instanceof Error && !(error.name === 'ZodError')
          ? error.message
          : 'Could not update Mukai. Check your connection and retry.',
    });
  }
  private set(next: Omit<DesktopUpdateState, 'currentVersion' | 'automaticUpdates'>) {
    this.state = {
      currentVersion: this.state.currentVersion,
      automaticUpdates: this.state.automaticUpdates,
      ...next,
    };
  }
}
