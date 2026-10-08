import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessService } from '../services/processService';
import { WorkspaceFileService } from '../services/workspaceFileService';
import { BrowserService } from '../services/browserService';
import { executeImage } from '../tools/image/execute';
import { terminalDefinition, processDefinition } from '../tools/terminal/definition';
import { fileOperationsDefinition } from '../tools/file-operations/definition';
import { browserDefinition } from '../tools/browser/definition';
import { imageDefinition } from '../tools/image/definition';
import type { FileMutationSnapshot } from '../../shared/fileChanges';
import type { Computer } from './protocol';

/** The same dispatcher can run locally in tests or inside the Linux guest. */
export class GuestDispatcher implements Computer {
  private processes = new ProcessService();
  private browsers: BrowserService;
  constructor(
    private folder: string,
    private dataDir: string,
  ) {
    this.browsers = new BrowserService(dataDir, undefined, !process.env.DISPLAY);
  }
  async request(
    method: Parameters<Computer['request']>[0],
    input: unknown,
    owner: Parameters<Computer['request']>[2],
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    switch (method) {
      case 'terminal':
        return this.processes.run(
          owner,
          this.folder,
          terminalDefinition.inputSchema.parse(input),
          signal,
        );
      case 'process': {
        const value = processDefinition.inputSchema.parse(input);
        if (value.action === 'list') return this.processes.list(owner);
        const id = z.string().uuid().parse(value.sessionId);
        switch (value.action) {
          case 'kill':
            return this.processes.kill(owner, id);
          case 'write':
            return this.processes.write(owner, id, z.string().parse(value.text));
          case 'wait':
            return this.processes.wait(owner, id, value.waitMs ?? 1000, signal);
          default:
            return this.processes.read(owner, id, value.offset);
        }
      }
      case 'files': {
        const changes: FileMutationSnapshot[] = [];
        const files = new WorkspaceFileService(this.folder, this.dataDir, (snapshot) =>
          changes.push(snapshot),
        );
        const result = await files.execute(
          fileOperationsDefinition.inputSchema.parse(input),
          signal,
        );
        return { result, changes };
      }
      case 'image': {
        const output = await executeImage(
          imageDefinition.inputSchema.parse(input),
          {
            owner,
            signal,
            folder: this.folder,
            vision: true,
            budget: { remaining: 1 },
            onActivity: () => {},
          },
          'guest-image',
        );
        if (!output.ok) throw new Error('error' in output ? output.error : 'Image read failed.');
        return output.result;
      }
      case 'browser': {
        const value = browserDefinition.inputSchema.parse(input);
        const result = await this.browsers.execute(
          owner,
          {
            ...value,
            target: value.target === 'chrome-default' ? 'chrome-default' : 'chrome',
          },
          signal,
        );
        if (
          value.action === 'screenshot' &&
          result &&
          typeof result === 'object' &&
          'image' in result &&
          typeof result.image === 'string'
        ) {
          const directory = join(this.dataDir, 'screenshots');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, randomUUID() + '.png');
          await writeFile(path, Buffer.from(result.image, 'base64'), { signal, mode: 0o600 });
          return { ...result, path };
        }
        return result;
      }
      case 'download': {
        const { path } = z.object({ path: z.string().min(1).max(4000) }).parse(input);
        const file = await new WorkspaceFileService(this.folder, this.dataDir).download(path);
        return { name: file.name, bytes: file.bytes.toString('base64') };
      }
    }
  }
  async shutdown() {
    await Promise.allSettled([this.processes.shutdown(), this.browsers.shutdown()]);
  }
}
