import { expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { qemuControl } from './qemuControl';
import { Frames, encodeFrame } from './protocol';

it('negotiates QMP and sends ACPI powerdown over its private connection', async () => {
  const onEvent = vi.fn();
  const control = await qemuControl(onEvent);
  expect(control.powerdown()).toBe(false);
  const socket = connect(control.port, '127.0.0.1');
  socket.on('error', () => {});
  const frames = new Frames();
  const received: unknown[] = [];
  socket.on('data', (bytes) => {
    for (const frame of frames.push(bytes)) {
      received.push(frame);
      if (frame && typeof frame === 'object' && 'id' in frame && frame.id === 'capabilities')
        socket.write(encodeFrame({ return: {}, id: 'capabilities' }));
      else if (
        frame &&
        typeof frame === 'object' &&
        'execute' in frame &&
        frame.execute === 'query-status' &&
        'id' in frame
      )
        socket.write(encodeFrame({ return: { status: 'running' }, id: frame.id }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(encodeFrame({ QMP: { version: {} } }));
    await expect
      .poll(() => received)
      .toContainEqual({ execute: 'qmp_capabilities', id: 'capabilities' });
    // Readiness comes from the reply, independently of delivery of the greeting.
    await expect.poll(() => control.powerdown()).toBe(true);
    await expect(control.status()).resolves.toBe('running');
    await expect
      .poll(() => received)
      .toContainEqual({ execute: 'system_powerdown', id: 'powerdown' });
    socket.write(encodeFrame({ event: 'SUSPEND', data: {} }));
    socket.write(
      encodeFrame({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-shutdown' } }),
    );
    await expect
      .poll(() => onEvent.mock.calls)
      .toEqual([
        ['SUSPEND', undefined],
        ['SHUTDOWN', 'guest-shutdown'],
      ]);
    const intruder = connect(control.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      intruder.once('error', () => resolve());
      intruder.once('connect', () => {
        intruder.destroy();
        reject(new Error('Control listener remained open.'));
      });
    });
  } finally {
    socket.destroy();
    control.close();
  }
});
