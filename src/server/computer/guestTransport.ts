import * as fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { encodeFrame, Frames, FRAME_LIMIT, PROTOCOL_VERSION } from './protocol';

export interface GuestChannel {
  reader: Readable;
  writer: Writable;
  close(): void;
}
interface Connection extends GuestChannel {
  authenticated: boolean;
  frames: Frames;
  hello?: NodeJS.Timeout;
  writing: boolean;
}
export function openGuestChannel(device: string): GuestChannel {
  const fd = fs.openSync(device, 'r+');
  const closures: ((error: NodeJS.ErrnoException | null) => void)[] = [];
  const filesystem = {
    ...fs,
    close(closingFd: number, callback: (error: NodeJS.ErrnoException | null) => void) {
      closures.push(callback);
      // Each stream waits for its own pending I/O before calling close. Wait for
      // both, then close once so a reused descriptor cannot be closed by stale I/O.
      if (closures.length === 2)
        fs.close(closingFd, (error) => {
          for (const finish of closures) finish(error);
        });
    },
  };
  const reader = fs.createReadStream(device, { fd, autoClose: false, fs: filesystem });
  const writer = fs.createWriteStream(device, { fd, autoClose: false, fs: filesystem });
  let closed = false;
  return {
    reader,
    writer,
    close() {
      if (closed) return;
      closed = true;
      reader.destroy();
      writer.destroy();
    },
  };
}

/** Reopens only the transport. Requests and the tools worker belong to its caller. */
export class GuestTransport {
  private connection?: Connection;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  constructor(
    private options: {
      open(): GuestChannel;
      hello: unknown;
      onFrame(frame: unknown): void;
      onReady?(): void;
      onDisconnect?(): void;
      onError?(error: unknown): void;
    },
  ) {}
  get ready() {
    return this.connection?.authenticated === true;
  }
  start() {
    if (this.closed || this.connection || this.retry) return;
    try {
      const channel = this.options.open();
      const connection: Connection = {
        ...channel,
        frames: new Frames(),
        authenticated: false,
        writing: false,
      };
      this.connection = connection;
      const failed = (error?: unknown) => this.disconnect(connection, error);
      channel.reader.on('data', (chunk: Buffer) => {
        if (this.connection !== connection) return;
        try {
          for (const frame of connection.frames.push(Buffer.from(chunk))) {
            if (z.object({ ready: z.literal(PROTOCOL_VERSION) }).safeParse(frame).success) {
              if (!connection.authenticated) {
                connection.authenticated = true;
                this.failures = 0;
                this.options.onReady?.();
              }
              this.flush(connection);
            } else if (connection.authenticated) this.options.onFrame(frame);
          }
        } catch (error) {
          failed(error);
        }
      });
      channel.reader.on('end', () => failed());
      channel.reader.on('close', () => failed());
      channel.reader.on('error', failed);
      channel.writer.on('close', () => failed());
      channel.writer.on('error', failed);
      this.hello(connection);
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleRetry();
    }
  }
  send(value: unknown, volatile = false): boolean {
    if (this.closed || (volatile && (!this.ready || this.queue.length > 0))) return false;
    const frame = encodeFrame(value);
    if (this.queuedBytes + frame.length > FRAME_LIMIT * 2 || this.queue.length >= 32) return false;
    this.queue.push(frame);
    this.queuedBytes += frame.length;
    if (this.connection) this.flush(this.connection);
    return true;
  }
  private hello(connection: Connection) {
    if (this.connection !== connection || this.closed) return;
    // Keep announcing slowly after ready: a QEMU backend can reconnect without ending the stream.
    if (connection.writer.writableLength < 65536) {
      connection.writer.write(encodeFrame(this.options.hello), (error) => {
        if (error) this.disconnect(connection, error);
      });
    }
    connection.hello = setTimeout(
      () => this.hello(connection),
      connection.authenticated ? 5000 : 500,
    );
    connection.hello.unref();
  }
  private flush(connection: Connection) {
    if (
      this.connection !== connection ||
      !connection.authenticated ||
      connection.writing ||
      !this.queue.length
    )
      return;
    connection.writing = true;
    const frame = this.queue[0];
    connection.writer.write(frame, (error) => {
      if (this.connection !== connection) return;
      connection.writing = false;
      if (error) {
        this.disconnect(connection, error);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= frame.length;
      this.flush(connection);
    });
  }
  private disconnect(connection: Connection, error?: unknown) {
    if (this.connection !== connection) return;
    this.connection = undefined;
    if (connection.hello) clearTimeout(connection.hello);
    try {
      connection.close();
    } catch (closeError) {
      this.options.onError?.(closeError);
    }
    if (error) this.options.onError?.(error);
    this.options.onDisconnect?.();
    this.scheduleRetry();
  }
  private scheduleRetry() {
    if (this.closed || this.retry) return;
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.start();
    }, delay);
    // Reconnection must keep the service alive while its previous stream has ended.
  }
  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection?.hello) clearTimeout(connection.hello);
    connection?.close();
    this.queue = [];
    this.queuedBytes = 0;
  }
}
