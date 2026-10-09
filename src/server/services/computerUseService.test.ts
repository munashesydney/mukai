import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ComputerUseService } from './computerUseService';
import type {
  DesktopBackend,
  DesktopCommand,
  DesktopDisplay,
} from '../computer/computer_use/protocol';

const owner = { workspaceId: 'workspace', botId: 'bot', conversationId: 'conversation' };
const signal = () => new AbortController().signal;
const services: ComputerUseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
async function fixture() {
  const display: DesktopDisplay = {
    id: 'screen',
    name: 'Retina left',
    x: -800,
    y: 50,
    width: 800,
    height: 600,
    pixelWidth: 1600,
    pixelHeight: 1200,
    primary: true,
  };
  const image = (
    await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#123456' } })
      .png()
      .toBuffer()
  ).toString('base64');
  const request = vi.fn(async (input: DesktopCommand): Promise<unknown> => {
    if (input.action === 'displays') return { displays: [display] };
    if (input.action === 'screenshot') return { image };
    if (input.action === 'status') return { available: true };
    return { done: true };
  });
  const backend: DesktopBackend = { request, shutdown: vi.fn(async () => {}) };
  const service = new ComputerUseService(backend);
  services.push(service);
  return { service, request, display };
}

describe('computer use desktop service', () => {
  it('maps resized screenshot pixels to a scaled display with a negative origin', async () => {
    const { service, request } = await fixture();
    const capture = (await service.execute(
      owner,
      { action: 'screenshot', maxDimension: 800 },
      signal(),
    )) as { screenshotId: string; width: number; height: number };
    expect(capture).toMatchObject({ width: 800, height: 600 });
    await service.execute(
      owner,
      { action: 'move', screenshotId: capture.screenshotId, x: 200, y: 150 },
      signal(),
    );
    expect(request).toHaveBeenLastCalledWith(
      { action: 'move', displayId: 'screen', x: -600, y: 200 },
      expect.any(AbortSignal),
    );
  });
  it('rejects foreign, expired, out-of-bounds and changed-display captures before input', async () => {
    const { service, request, display } = await fixture();
    const capture = (await service.execute(owner, { action: 'screenshot' }, signal())) as {
      screenshotId: string;
    };
    const move = { action: 'move' as const, screenshotId: capture.screenshotId, x: 100, y: 100 };
    const before = request.mock.calls.filter(([input]) => input.action === 'move').length;
    await expect(service.execute({ ...owner, botId: 'other' }, move, signal())).rejects.toThrow(
      'another conversation',
    );
    await expect(service.execute(owner, { ...move, x: -1 }, signal())).rejects.toThrow('outside');
    display.width = 700;
    await expect(service.execute(owner, move, signal())).rejects.toThrow('configuration changed');
    display.width = 800;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try {
      await expect(service.execute(owner, move, signal())).rejects.toThrow('expired');
    } finally {
      now.mockRestore();
    }
    expect(request.mock.calls.filter(([input]) => input.action === 'move')).toHaveLength(before);
  });
  it('validates the destination before starting a drag and releases a button after interrupted movement', async () => {
    const { service, request } = await fixture();
    await expect(
      service.execute(owner, { action: 'drag', x: -600, y: 200, endX: 50, endY: 50 }, signal()),
    ).rejects.toThrow('outside');
    expect(request.mock.calls.some(([input]) => input.action === 'button')).toBe(false);
    const controller = new AbortController();
    const native = request.getMockImplementation()!;
    request.mockImplementation(async (input) => {
      if (input.action === 'button' && input.down) controller.abort();
      return native(input);
    });
    await expect(
      service.execute(
        owner,
        { action: 'drag', x: -600, y: 200, endX: -400, endY: 300 },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(request).toHaveBeenLastCalledWith(
      { action: 'button', button: 'left', down: false },
      expect.any(AbortSignal),
    );
  });
  it('releases partially injected chords on backend errors and serializes other callers', async () => {
    const { service, request } = await fixture();
    request
      .mockImplementationOnce(async () => ({ done: true }))
      .mockImplementationOnce(async () => {
        throw new Error('Injection failed');
      });
    await expect(
      service.execute(owner, { action: 'press', key: 'CTRL+L' }, signal()),
    ).rejects.toThrow('Injection failed');
    expect(request.mock.calls.slice(-2).map(([value]) => value)).toEqual([
      { action: 'key', key: 'L', down: false },
      { action: 'key', key: 'CTRL', down: false },
    ]);
    request.mockClear();
    await Promise.all([
      service.execute(owner, { action: 'click', x: -600, y: 200, clicks: 2 }, signal()),
      service.execute({ ...owner, botId: 'other' }, { action: 'press', key: 'ENTER' }, signal()),
    ]);
    const events = request.mock.calls.map(([value]) => value);
    const firstKey = events.findIndex((value) => value.action === 'key');
    expect(events.slice(0, firstKey).filter((value) => value.action === 'button')).toEqual([
      { action: 'button', button: 'left', down: true },
      { action: 'button', button: 'left', down: false },
      { action: 'button', button: 'left', down: true },
      { action: 'button', button: 'left', down: false },
    ]);
  });
  it('expires held keys, releases on caller abort and releases before another conversation takes control', async () => {
    const { service, request } = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await service.execute(owner, { action: 'key_down', key: 'SHIFT' }, signal());
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenLastCalledWith(
      { action: 'key', key: 'SHIFT', down: false },
      expect.any(AbortSignal),
    );
    const controller = new AbortController();
    await service.execute(owner, { action: 'key_down', key: 'CTRL' }, controller.signal);
    controller.abort();
    await service.execute(owner, { action: 'status' }, signal());
    expect(request.mock.calls.at(-2)?.[0]).toEqual({ action: 'key', key: 'CTRL', down: false });
    await service.execute(owner, { action: 'key_down', key: 'ALT' }, signal());
    await service.execute({ ...owner, conversationId: 'other' }, { action: 'status' }, signal());
    expect(request.mock.calls.at(-2)?.[0]).toEqual({ action: 'key', key: 'ALT', down: false });
  });
  it('bounds waits, preserves Unicode chunks and rejects missing fields without native input', async () => {
    const { service, request } = await fixture();
    expect(() => service.execute(owner, { action: 'click', x: 1 }, signal())).toThrow(
      'y is required',
    );
    expect(() => service.execute(owner, { action: 'wait', durationMs: 5001 }, signal())).toThrow();
    expect(request).not.toHaveBeenCalled();
    const text = '🌱'.repeat(40) + 'café世界';
    await service.execute(owner, { action: 'type', text }, signal());
    expect(
      request.mock.calls.map(([input]) => (input.action === 'type' ? input.text : '')).join(''),
    ).toBe(text);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.execute(owner, { action: 'wait', durationMs: 5000 }, controller.signal),
    ).rejects.toThrow();
  });
});
