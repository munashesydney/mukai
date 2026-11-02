import { COMPUTER_AUDIO } from '../../../../shared/computerAudio';

export type ComputerAudioState = 'connecting' | 'playing' | 'retrying' | 'blocked' | 'failed';

/** Small independently decodable PCM packets, with bounded scheduling and stale-packet rejection. */
export class ComputerAudioPlayer {
  private gain: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private origin?: { server: number; local: number };
  private closed = false;
  constructor(
    private context: AudioContext = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: COMPUTER_AUDIO.sampleRate,
    }),
  ) {
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }
  get needsGesture() {
    return this.context.state !== 'running';
  }
  async resume() {
    await this.context.resume();
    if (this.context.state !== 'running')
      throw new Error('Sound is blocked. Click Enable sound to try again.');
  }
  volume(value: number) {
    this.gain.gain.value = Math.max(0, Math.min(1, value));
  }
  configure(raw: string) {
    if (raw.length > 1024) throw new Error('Invalid audio format.');
    const format = JSON.parse(raw);
    if (
      format.version !== COMPUTER_AUDIO.version ||
      format.sampleRate !== COMPUTER_AUDIO.sampleRate ||
      format.channels !== COMPUTER_AUDIO.channels ||
      format.samplesPerFrame !== COMPUTER_AUDIO.samplesPerFrame ||
      !Number.isFinite(format.startedAt)
    )
      throw new Error('Unsupported workspace audio format.');
    this.flush();
    this.origin = { server: format.startedAt, local: performance.now() };
  }
  write(packet: ArrayBuffer) {
    const bytes = packet.byteLength - COMPUTER_AUDIO.headerBytes;
    if (
      !this.origin ||
      bytes <= 0 ||
      bytes % COMPUTER_AUDIO.frameBytes ||
      bytes > COMPUTER_AUDIO.frameBytes * 5
    )
      throw new Error('Invalid workspace audio packet.');
    const view = new DataView(packet);
    const timestamp = view.getFloat64(0, true);
    const age = performance.now() - this.origin.local - (timestamp - this.origin.server);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid audio timestamp.');
    // Never replay seconds of old sound after tab suspension or network buffering.
    if (age > 350 || age < -1000 || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    if (this.nextTime > now + 0.2 || this.sources.size >= 16) return;
    const samples = bytes / (2 * COMPUTER_AUDIO.channels);
    const buffer = this.context.createBuffer(
      COMPUTER_AUDIO.channels,
      samples,
      COMPUTER_AUDIO.sampleRate,
    );
    for (let channel = 0; channel < COMPUTER_AUDIO.channels; channel++) {
      const target = buffer.getChannelData(channel);
      for (let index = 0; index < samples; index++)
        target[index] =
          view.getInt16(
            COMPUTER_AUDIO.headerBytes + (index * COMPUTER_AUDIO.channels + channel) * 2,
            true,
          ) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    const when = Math.max(now + 0.04, this.nextTime);
    source.start(when);
    this.nextTime = when + buffer.duration;
  }
  flush() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = 0;
    this.origin = undefined;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.gain.disconnect();
    if (this.context.state !== 'closed') void this.context.close().catch(() => {});
  }
}

/** Construct synchronously from the unmute click so AudioContext retains user activation. */
export function startComputerAudio(options: {
  open(signal: AbortSignal): Promise<string>;
  state(state: ComputerAudioState, message?: string): void;
  volume: number;
}) {
  const player = new ComputerAudioPlayer();
  player.volume(options.volume);
  let stopped = false;
  let generation = 0;
  let retries = 0;
  let socket: WebSocket | undefined;
  let request: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stable: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(deadline);
    clearTimeout(stable);
    request?.abort();
    request = undefined;
    const previous = socket;
    socket = undefined;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
      previous.close();
    }
    player.flush();
  };
  const failed = (current: number, message: string) => {
    if (stopped || current !== generation) return;
    generation++;
    release();
    if (retries >= 4) {
      player.close();
      options.state('failed', message);
      return;
    }
    options.state('retrying', 'Reconnecting sound…');
    retry = setTimeout(() => void connect(), [1000, 2000, 4000, 8000][retries++]);
  };
  const connect = async () => {
    if (stopped) return;
    const current = ++generation;
    options.state(retries ? 'retrying' : 'connecting');
    request = new AbortController();
    deadline = setTimeout(
      () => failed(current, 'Workspace audio did not become ready. Try enabling sound again.'),
      10000,
    );
    try {
      const url = await options.open(request.signal);
      if (stopped || current !== generation) return;
      const next = new WebSocket(url);
      next.binaryType = 'arraybuffer';
      socket = next;
      let configured = false;
      next.onmessage = (event: MessageEvent) => {
        if (stopped || current !== generation) return;
        try {
          if (!configured && typeof event.data === 'string') {
            player.configure(event.data);
            configured = true;
            clearTimeout(deadline);
            stable = setTimeout(() => {
              retries = 0;
            }, 30000);
            options.state('playing');
          } else if (configured && event.data instanceof ArrayBuffer) player.write(event.data);
          else throw new Error('Invalid workspace audio stream.');
        } catch {
          failed(current, 'Workspace audio could not be played. Try enabling sound again.');
        }
      };
      next.onerror = () => failed(current, 'Could not connect to workspace audio.');
      next.onclose = () =>
        failed(current, 'Workspace audio disconnected. Try enabling sound again.');
    } catch (error) {
      failed(
        current,
        error instanceof Error ? error.message : 'Could not connect to workspace audio.',
      );
    }
  };
  let activated = false;
  const resume = async () => {
    await player.resume();
    if (stopped || activated) return;
    activated = true;
    options.state('connecting');
    void connect();
  };
  options.state(
    player.needsGesture ? 'blocked' : 'connecting',
    player.needsGesture ? 'Sound is on. Click anywhere to allow playback.' : undefined,
  );
  void resume().catch(() => {
    if (!stopped) options.state('blocked', 'Sound is on. Click anywhere to allow playback.');
  });
  return {
    resume,
    volume(value: number) {
      player.volume(value);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearTimeout(retry);
      release();
      player.close();
    },
  };
}
