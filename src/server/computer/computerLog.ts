import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Serialized, bounded diagnostic files. Never retain tool inputs or boot credentials here. */
export class ComputerLog {
  private writing: Promise<void> = Promise.resolve();
  private queued = 0;
  private failed = false;
  constructor(
    readonly path: string,
    private maxBytes = 2 * 1024 * 1024,
    private onError?: () => void,
  ) {}
  append(value: string | Buffer) {
    // A noisy kernel must not build an unbounded queue in the host process.
    if (this.queued >= 64) return;
    const bytes = Buffer.from(value).subarray(0, Math.min(this.maxBytes, 64 * 1024));
    this.queued++;
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const size = await stat(this.path).then(
          (item) => item.size,
          () => 0,
        );
        if (size + bytes.length > this.maxBytes) {
          await unlink(this.path + '.2').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          await rename(this.path + '.1', this.path + '.2').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          await rename(this.path, this.path + '.1').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        await appendFile(this.path, bytes, { mode: 0o600 });
      })
      .catch(() => {
        if (!this.failed) this.onError?.();
        this.failed = true;
      })
      .finally(() => this.queued--);
  }
  flush() {
    return this.writing;
  }
}
