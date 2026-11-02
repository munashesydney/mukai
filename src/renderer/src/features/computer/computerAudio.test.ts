import { afterEach, expect, it, vi } from 'vitest';
import { ComputerAudioPlayer, startComputerAudio } from './computerAudio';
import { COMPUTER_AUDIO } from '../../../../shared/computerAudio';

function audio() {
  const channels: Float32Array[][] = [];
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    createGain: () => gain,
    createBuffer: (_n: number, samples: number, rate: number) => {
      const output = [new Float32Array(samples), new Float32Array(samples)];
      channels.push(output);
      return { duration: samples / rate, getChannelData: (channel: number) => output[channel] };
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  };
  return { context, gain, sources, channels };
}
function packet(timestamp = 1000, frames = 1) {
  const bytes = new ArrayBuffer(8 + COMPUTER_AUDIO.frameBytes * frames);
  const view = new DataView(bytes);
  view.setFloat64(0, timestamp, true);
  for (let offset = 8; offset < bytes.byteLength; offset += 4) {
    view.setInt16(offset, 16384, true);
    view.setInt16(offset + 2, -16384, true);
  }
  return bytes;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('decodes stereo s16le into distinct left/right playback channels and applies volume', () => {
  const mock = audio();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const player = new ComputerAudioPlayer(mock.context as unknown as AudioContext);
  player.configure(JSON.stringify({ ...COMPUTER_AUDIO, startedAt: 1000 }));
  player.volume(0.3);
  player.write(packet(1000, 2));
  expect(mock.channels[0][0][0]).toBe(0.5);
  expect(mock.channels[0][1][0]).toBe(-0.5);
  expect(mock.channels[0][0].length).toBe(1920);
  expect(mock.gain.gain.value).toBe(0.3);
  expect(mock.sources[0].start).toHaveBeenCalledWith(0.04);
  player.close();
  expect(mock.sources[0].stop).toHaveBeenCalledOnce();
  expect(mock.context.close).toHaveBeenCalledOnce();
});
it('bounds scheduled audio, rejects malformed packets, and drops stale audio after a suspended tab resumes', () => {
  const mock = audio();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const player = new ComputerAudioPlayer(mock.context as unknown as AudioContext);
  player.configure(JSON.stringify({ ...COMPUTER_AUDIO, startedAt: 1000 }));
  for (let index = 0; index < 200; index++) player.write(packet());
  expect(mock.sources.length).toBeLessThanOrEqual(11);
  const count = mock.sources.length;
  now = 5000;
  mock.context.currentTime = 5;
  player.write(packet());
  expect(mock.sources.length).toBe(count);
  expect(() => player.write(new ArrayBuffer(9))).toThrow('Invalid');
  expect(() => player.write(packet(1000, 6))).toThrow('Invalid');
  player.close();
});
it('uses fresh tickets for bounded reconnects and never opens late connections after Stop', async () => {
  vi.useFakeTimers();
  const mock = audio();
  vi.stubGlobal('AudioContext', function () {
    return mock.context;
  });
  const sockets: { onclose?: () => void; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      onclose?: () => void;
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    },
  );
  const open = vi.fn(async () => 'ws://fixture/audio');
  const state = vi.fn();
  const stream = startComputerAudio({ open, state, volume: 0.7 });
  await vi.advanceTimersByTimeAsync(0);
  for (const wait of [1000, 2000, 4000, 8000]) {
    sockets.at(-1)!.onclose?.();
    await vi.advanceTimersByTimeAsync(wait);
  }
  expect(open).toHaveBeenCalledTimes(5);
  sockets.at(-1)!.onclose?.();
  expect(state).toHaveBeenLastCalledWith('failed', expect.any(String));
  stream.stop();
  stream.stop();
  expect(mock.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);

  const another = audio();
  vi.stubGlobal('AudioContext', function () {
    return another.context;
  });
  let resolve!: (url: string) => void;
  let signal!: AbortSignal;
  const pending = startComputerAudio({
    open: (current) => {
      signal = current;
      return new Promise<string>((done) => {
        resolve = done;
      });
    },
    state: vi.fn(),
    volume: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const previous = sockets.length;
  pending.stop();
  resolve('ws://fixture/late');
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(true);
  expect(sockets.length).toBe(previous);
});

it('keeps default sound armed while autoplay is blocked and starts once on a user gesture', async () => {
  vi.useFakeTimers();
  const mock = audio();
  mock.context.state = 'suspended';
  let allow!: () => void;
  mock.context.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        allow = resolve;
      }),
  );
  mock.context.resume.mockImplementationOnce(async () => {
    mock.context.state = 'running';
    allow();
  });
  vi.stubGlobal('AudioContext', function () {
    return mock.context;
  });
  vi.stubGlobal(
    'WebSocket',
    class {
      close = vi.fn();
    },
  );
  const open = vi.fn(async () => 'ws://fixture/audio');
  const state = vi.fn();
  const stream = startComputerAudio({ open, state, volume: 0.7 });
  expect(state).toHaveBeenCalledWith('blocked', expect.stringContaining('Sound is on'));
  expect(open).not.toHaveBeenCalled();
  await stream.resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledOnce();
  expect(mock.context.close).not.toHaveBeenCalled();
  stream.stop();
  expect(mock.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
