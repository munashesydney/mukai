import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setupProcess } from './setupProcess';
import { probeAccelerator } from './setupProbe';

vi.mock('./setupProcess', () => ({ setupProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('virtualization control socket', () => {
  it('negotiates QMP before quitting and handles fragmented messages', async () => {
    const commands: string[] = [];
    vi.mocked(setupProcess).mockImplementation(async (_binary, args, _signal, input) => {
      expect(input).toBeUndefined();
      expect(args).not.toContain('stdio');
      const address = args[args.indexOf('-qmp') + 1];
      const socket = createConnection({
        host: '127.0.0.1',
        port: Number(address.split(':').at(-1)),
      });
      await once(socket, 'connect');
      let buffer = '';
      socket.on('data', (bytes) => {
        buffer += bytes.toString();
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          commands.push(frame.execute);
          socket.write(JSON.stringify({ return: {}, id: frame.id }) + '\n');
        }
      });
      socket.write('{"Q');
      socket.write('MP":{}}\r\n');
      await once(socket, 'end');
      socket.destroy();
      return { code: 0, output: '' };
    });
    expect((await probeAccelerator('qemu', 'whpx', new AbortController().signal)).code).toBe(0);
    expect(commands).toEqual(['qmp_capabilities', 'quit']);
  });
  it('does not treat an early clean exit as successful virtualization', async () => {
    vi.mocked(setupProcess).mockResolvedValue({ code: 0, output: '' });
    expect((await probeAccelerator('qemu', 'whpx', new AbortController().signal)).code).toBe(-1);
  });
  it('preserves accelerator startup failures', async () => {
    vi.mocked(setupProcess).mockResolvedValue({ code: 1, output: 'WHPX unavailable' });
    expect(await probeAccelerator('qemu', 'whpx', new AbortController().signal)).toEqual({
      code: 1,
      output: 'WHPX unavailable',
    });
  });
});
