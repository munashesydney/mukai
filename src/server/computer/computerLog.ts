import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Serialized, bounded diagnostic files. Never retain tool inputs or boot credentials here. */
export class ComputerLog {
  private writing: Promise<void> = Promise.resolve();
  private pending: { bytes: Buffer; length: number }[] = [];
  private scheduled = false;
  private queuedBytes = 0;
  droppedBytes = 0;
  private failed = false;
  constructor(
    readonly path: string,
    private maxBytes = 2 * 1024 * 1024,
    private onError?: () => void,
  ) {}
  append(value: string | Buffer) {
    // A noisy kernel must not build an unbounded queue in the host process.
    const incoming = Buffer.from(value);
    const bytes = incoming.subarray(0, Math.min(this.maxBytes, 64 * 1024));
    this.droppedBytes += incoming.length - bytes.length;
    if (this.queuedBytes + bytes.length > 1024 * 1024) {
      this.droppedBytes += bytes.length;
      return;
    }
    this.queuedBytes += bytes.length;
    const capacity = Math.min(this.maxBytes, 64 * 1024);
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.pending.at(-1);
      if (!tail || tail.length === capacity) {
        tail = { bytes: Buffer.allocUnsafe(capacity), length: 0 };
        this.pending.push(tail);
      }
      const count = Math.min(bytes.length - offset, capacity - tail.length);
      bytes.copy(tail.bytes, tail.length, offset, offset + count);
      tail.length += count;
      offset += count;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.writing = this.writing
      .then(async () => {
        while (this.pending.length) {
          const item = this.pending.shift()!;
          const bytes = item.bytes.subarray(0, item.length);
          try {
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const size = await stat(this.path).then(
              (item) => item.size,
              () => 0,
            );
            if (size + bytes.length > this.maxBytes) {
              await unlink(this.path + '.2').catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
              await rename(this.path + '.1', this.path + '.2').catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error;
                },
              );
              await rename(this.path, this.path + '.1').catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
            }
            await appendFile(this.path, bytes, { mode: 0o600 });
          } catch {
            if (!this.failed) this.onError?.();
            this.failed = true;
          } finally {
            this.queuedBytes -= bytes.length;
          }
        }
        this.scheduled = false;
      })
      .catch(() => {
        this.scheduled = false;
      });
  }
  flush() {
    return this.writing;
  }
}
