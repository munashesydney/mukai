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
import { mediaDefinition } from '../tools/media/definition';
import { executeMedia } from '../tools/media/execute';
import type { FileMutationSnapshot } from '../../shared/fileChanges';
import type { Computer, ComputerHelper } from './protocol';
import { GuestCapabilities } from './guestCapabilities';
import { guestBrowserExecutable } from './guestBrowser';
import { ComputerUseService } from '../services/computerUseService';
import { NativeDesktopBackend } from './computer_use/nativeBackend';
import { computerUseDefinition } from '../tools/computer_use/definition';
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_DOWNLOAD_LIMIT } from '../../shared/artifacts';

/** The same dispatcher can run locally in tests or inside the Linux guest. */
export class GuestDispatcher implements Computer {
  private processes = new ProcessService();
  private browsers: BrowserService;
  private capabilities: GuestCapabilities;
  private desktop = new ComputerUseService(new NativeDesktopBackend('/opt/mukai-guest/bridge'));
  constructor(
    private folder: string,
    private dataDir: string,
  ) {
    this.capabilities = new GuestCapabilities(folder, dataDir);
    this.browsers = new BrowserService(
      dataDir,
      undefined,
      !process.env.DISPLAY,
      guestBrowserExecutable(),
    );
  }
  async request(
    method: Parameters<Computer['request']>[0],
    input: unknown,
    owner: Parameters<Computer['request']>[2],
    signal: AbortSignal,
    helper?: ComputerHelper,
  ): Promise<unknown> {
    signal.throwIfAborted();
    switch (method) {
      case 'capability':
        return this.capabilities.request(input, signal, helper);
      case 'computer_use': {
        const value = computerUseDefinition.inputSchema.parse(input);
        const result = await this.desktop.execute(owner, value, signal);
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
      case 'terminal': {
        const privateInput = z
          .object({
            settingsEnvironment: z.record(z.string(), z.string()).optional(),
            automaticEnvironment: z.record(z.string(), z.string()).optional(),
          })
          .parse(input);
        return this.processes.run(
          owner,
          this.folder,
          terminalDefinition.inputSchema.parse(input),
          signal,
          {
            settingsEnvironment: privateInput.settingsEnvironment,
            automaticEnvironment: privateInput.automaticEnvironment,
            onStart: helper
              ? async (snapshot) => {
                  await helper('terminal_started', [snapshot]);
                }
              : undefined,
          },
        );
      }
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
        if (
          input &&
          typeof input === 'object' &&
          'action' in input &&
          input.action === 'inspect_artifact'
        ) {
          const value = z.object({ path: z.string().min(1).max(4000) }).parse(input);
          return files.inspect(value.path);
        }
        if (
          input &&
          typeof input === 'object' &&
          'action' in input &&
          input.action === 'copy_attachment'
        ) {
          const value = z
            .object({
              path: z.string().min(1).max(4000),
              bytes: z.string().max(14 * 1024 * 1024),
              overwrite: z.boolean().optional(),
            })
            .parse(input);
          const result = await files.copyAttachment(
            value.path,
            Buffer.from(value.bytes, 'base64'),
            value.overwrite === true,
            signal,
          );
          return { result, changes };
        }
        const result = await files.execute(
          fileOperationsDefinition.inputSchema.parse(input),
          signal,
        );
        return { result, changes };
      }
      case 'media': {
        const output = await executeMedia(
          mediaDefinition.inputSchema.parse(input),
          {
            owner,
            signal,
            folder: this.folder,
            vision: true,
            supportsAudio: true,
            supportsVideo: true,
            budget: { remaining: 1 },
            onActivity: () => {},
          },
          'guest-media',
        );
        if (!output.ok) throw new Error('error' in output ? output.error : 'Media read failed.');
        return output.result;
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
            target:
              value.action === 'profiles'
                ? value.target || 'chrome-default'
                : value.target === 'chrome-default'
                  ? 'chrome-default'
                  : 'chrome',
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
        const { path, maxBytes, offset, length, version } = z
          .object({
            path: z.string().min(1).max(4000),
            maxBytes: z.number().int().min(1).max(ARTIFACT_DOWNLOAD_LIMIT).optional(),
            offset: z.number().int().min(0).max(ARTIFACT_DOWNLOAD_LIMIT).optional(),
            length: z.number().int().min(1).max(ARTIFACT_CHUNK_BYTES).optional(),
            version: z.string().max(200).optional(),
          })
          .refine(
            (value) => (value.offset === undefined) === (value.length === undefined),
            'Chunk offset and length must be supplied together.',
          )
          .refine(
            (value) => value.offset !== undefined || (value.maxBytes ?? 0) <= 10 * 1024 * 1024,
            'Large downloads require chunked transfer.',
          )
          .parse(input);
        const file = await new WorkspaceFileService(this.folder, this.dataDir).download(
          path,
          maxBytes,
          signal,
          offset !== undefined && length !== undefined ? { offset, length, version } : undefined,
        );
        return { ...file, bytes: file.bytes.toString('base64') };
      }
    }
  }
  async shutdown() {
    await Promise.allSettled([
      this.processes.shutdown(),
      this.browsers.shutdown(),
      this.desktop.shutdown(),
      this.capabilities.shutdown(),
    ]);
  }
}
