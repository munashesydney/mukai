import { describe, expect, it, vi } from 'vitest';
import { computerUseTools } from './execute';
import { toolCatalog } from '../registry';
import { workspaceToolIds } from '../../../shared/toolAssignments';
import { parseKeys } from '../../computer/computer_use/protocol';
import { computerTools } from '../../computer/tools';
import { GuestDispatcher } from '../../computer/guestDispatcher';
import { ComputerUseService } from '../../services/computerUseService';

const owner = { workspaceId: 'workspace', botId: 'bot', conversationId: 'conversation' };
const options = { toolCallId: 'computer-call', messages: [], context: undefined };
function context(vision = true) {
  return {
    owner,
    vision,
    signal: new AbortController().signal,
    budget: { remaining: 10 },
    onActivity: vi.fn(),
    saveScreenshot: vi.fn(async () => ({
      artifactId: 'artifact',
      path: '/saved/screen.png',
      width: 100,
      height: 80,
    })),
  };
}

describe('computer_use tool family', () => {
  it('registers its actions and normal bot assignment ID', () => {
    expect(workspaceToolIds).toContain('computer_use');
    expect(toolCatalog().find((tool) => tool.id === 'computer_use')?.actions).toContain('drag');
    expect(parseKeys('Command+ArrowLeft', 'darwin')).toEqual(['SUPER', 'LEFT']);
    expect(parseKeys('CMD+A', 'linux')).toEqual(['CTRL', 'A']);
    expect(() => parseKeys('A+CTRL')).toThrow('modifiers');
    expect(() => parseKeys('CTRL+CTRL')).toThrow('Invalid');
  });
  it('saves screenshots, excludes bytes from activity and delivers vision pixels', async () => {
    const runtime = context();
    const execute = vi.fn(async () => ({
      image: 'pixels',
      screenshotId: 'capture',
      display: { id: 'screen' },
    }));
    const tool = computerUseTools({ ...runtime, desktop: { execute } }).computer_use;
    const output = await tool.execute!({ action: 'screenshot' }, options);
    expect(runtime.saveScreenshot).toHaveBeenCalledWith('pixels');
    expect(output).toMatchObject({
      ok: true,
      result: {
        artifactId: 'artifact',
        path: '/saved/screen.png',
        screenshotUrl: '/artifacts/artifact',
      },
    });
    expect(runtime.onActivity.mock.calls.at(-1)?.[0].summary).not.toContain('pixels');
    expect(
      await tool.toModelOutput!({ output, input: { action: 'screenshot' }, toolCallId: 'call' }),
    ).toMatchObject({
      type: 'content',
      value: [
        { type: 'text' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'pixels' } },
      ],
    });
    const textTool = computerUseTools({
      ...runtime,
      vision: false,
      desktop: { execute },
    }).computer_use;
    const text = await textTool.toModelOutput!({
      output,
      input: { action: 'screenshot' },
      toolCallId: 'call',
    });
    expect(text).toMatchObject({ type: 'text' });
    expect(JSON.stringify(text)).not.toContain('pixels"');
    expect(JSON.stringify(text)).toContain('unsupported');
  });
  it('routes VM calls exclusively through the guest, combines cancellation, and consumes the runtime budget', async () => {
    const runtime = context();
    const request = vi.fn(async () => ({ available: true }));
    const tool = computerTools({
      ...runtime,
      computer: { request },
      fileBudget: { remaining: 10 },
      recordChange: vi.fn(),
      recordFile: vi.fn(),
    }).computer_use;
    const controller = new AbortController();
    expect(
      await tool.execute!({ action: 'status' }, { ...options, abortSignal: controller.signal }),
    ).toMatchObject({ ok: true });
    expect(request).toHaveBeenLastCalledWith(
      'computer_use',
      { action: 'status' },
      owner,
      expect.any(AbortSignal),
    );
    const forwarded = request.mock.calls.at(-1) as unknown as [
      string,
      unknown,
      unknown,
      AbortSignal,
    ];
    controller.abort();
    expect(forwarded[3].aborted).toBe(true);
    request.mockRejectedValueOnce(new Error('Guest unavailable'));
    expect(await tool.execute!({ action: 'status' }, options)).toMatchObject({
      ok: false,
      error: 'Guest unavailable',
    });
    runtime.budget.remaining = 0;
    const before = request.mock.calls.length;
    expect(await tool.execute!({ action: 'status' }, options)).toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledTimes(before);
  });
  it('keeps screenshot paths guest-readable while recording controller artifacts', async () => {
    const runtime = context();
    const request = vi.fn(async () => ({
      image: 'pixels',
      path: '/var/lib/mukai-guest/screenshots/capture.png',
    }));
    const tool = computerUseTools({ ...runtime, desktop: { request } }).computer_use;
    const output = await tool.execute!({ action: 'screenshot' }, options);
    expect(output).toMatchObject({
      ok: true,
      result: { path: '/var/lib/mukai-guest/screenshots/capture.png', artifactId: 'artifact' },
    });
    expect(runtime.saveScreenshot).toHaveBeenCalledWith('pixels');
    const model = await tool.toModelOutput!({
      output,
      input: { action: 'screenshot' },
      toolCallId: 'call',
    });
    expect(JSON.stringify(model)).not.toContain('/saved/screen.png');
  });
  it('dispatches inside the guest service and validates malformed actions', async () => {
    const execute = vi
      .spyOn(ComputerUseService.prototype, 'execute')
      .mockResolvedValue({ available: true });
    const guest = new GuestDispatcher('unused', 'unused');
    try {
      const signal = new AbortController().signal;
      expect(await guest.request('computer_use', { action: 'status' }, owner, signal)).toEqual({
        available: true,
      });
      expect(execute).toHaveBeenCalledWith(owner, { action: 'status' }, signal);
      await expect(
        guest.request('computer_use', { action: 'invalid' }, owner, signal),
      ).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      execute.mockRestore();
      await guest.shutdown();
    }
  });
});
