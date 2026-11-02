import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  COMPUTER_AUDIO,
  COMPUTER_AUDIO_PORT,
  COMPUTER_PULSE_SERVER,
} from '../../shared/computerAudio';

export function guestAudioKey(bootToken: string) {
  return createHmac('sha256', bootToken).update('mukai-output-audio-v1').digest('hex');
}

/** Runs in the guest's root bridge; the recorder itself runs as the desktop account. */
export class GuestAudioServer {
  private server?: Server;
  private clients = new Set<Socket>();
  constructor(
    private key: string,
    private uid: number,
    private gid: number,
    private launch: typeof spawn = spawn,
  ) {}

  listen(port = COMPUTER_AUDIO_PORT, host = '0.0.0.0') {
    if (this.server) throw new Error('Audio server is already running.');
    this.server = createServer((socket) => this.accept(socket));
    return new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        this.server!.off('error', reject);
        this.server!.on('error', () => {});
        resolve();
      });
    });
  }
  address() {
    return this.server?.address();
  }

  private accept(socket: Socket) {
    socket.on('error', () => socket.destroy());
    if (this.clients.size >= 4) return socket.destroy();
    this.clients.add(socket);
    socket.setNoDelay(true);
    const timer = setTimeout(() => socket.destroy(), 3000).unref();
    let header = Buffer.alloc(0);
    let child: ChildProcessWithoutNullStreams | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const authenticate = (bytes: Buffer) => {
      header = Buffer.concat([header, bytes]);
      if (header.length > 65) return socket.destroy();
      if (!header.includes(10)) return;
      socket.off('data', authenticate);
      clearTimeout(timer);
      if (header.length !== 65 || !timingSafeEqual(header, Buffer.from(this.key + '\n')))
        return socket.destroy();
      // No input or arbitrary capture commands are accepted from the viewer.
      socket.on('data', () => socket.destroy());
      child = this.launch(
        '/usr/bin/parec',
        [
          '--server=' + COMPUTER_PULSE_SERVER,
          '--device=mukai_output.monitor',
          '--format=s16le',
          '--rate=48000',
          '--channels=2',
          '--latency-msec=40',
        ],
        {
          uid: this.uid,
          gid: this.gid,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/home/mukai',
            USER: 'mukai',
            LANG: 'C.UTF-8',
            PULSE_SERVER: COMPUTER_PULSE_SERVER,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdin.end();
      child.stderr.resume();
      child.once('spawn', () => {
        if (!socket.destroyed) socket.write('OK\n');
      });
      let pending = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => {
        // Preserve sample/frame boundaries while dropping audio for a slow consumer.
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= COMPUTER_AUDIO.frameBytes) {
          if (socket.writableLength < COMPUTER_AUDIO.frameBytes * 5)
            socket.write(pending.subarray(0, COMPUTER_AUDIO.frameBytes));
          pending = pending.subarray(COMPUTER_AUDIO.frameBytes);
        }
      });
      child.once('error', () => socket.destroy());
      child.once('exit', () => {
        clearTimeout(killTimer);
        socket.destroy();
      });
    };
    socket.on('data', authenticate);
    socket.once('close', () => {
      clearTimeout(timer);
      this.clients.delete(socket);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        killTimer = setTimeout(() => child?.kill('SIGKILL'), 1000).unref();
      }
    });
  }
  async close() {
    for (const socket of this.clients) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
