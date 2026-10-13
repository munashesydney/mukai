import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compileWorkspaceCapability } from '../capabilities/compilation';
import { CapabilityWorkers } from '../capabilities/runtime';
import { ApiError } from '../config';
import { capabilityInput } from './capabilityProtocol';
import type { ComputerHelper } from './protocol';

/** Runs only in the unprivileged guest tools process. Controller owns registrations. */
export class GuestCapabilities {
  private runtime = new CapabilityWorkers();
  constructor(
    private folder: string,
    private dataDir: string,
  ) {}
  async request(raw: unknown, signal: AbortSignal, helper?: ComputerHelper) {
    let directory: string | undefined;
    try {
      const input = capabilityInput.parse(raw);
      signal.throwIfAborted();
      if (input.operation === 'compile')
        return {
          ok: true,
          value: await compileWorkspaceCapability(
            this.folder,
            this.dataDir,
            input.modulePath,
            signal,
          ),
        };
      const staging = join(this.dataDir, 'capability-staging');
      await mkdir(staging, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(staging, 'run-'));
      const file = join(directory, 'module.cjs');
      await writeFile(file, input.code, { mode: 0o600, signal });
      const data = input.data;
      const args =
        data.operation === 'handle'
          ? {
              ...(data.input as Record<string, unknown>),
              rawBody: Buffer.from((data.input as { rawBody: string }).rawBody, 'base64'),
            }
          : data.input;
      const value = await this.runtime.run(
        { ...data, input: args, file },
        input.timeoutMs,
        signal,
        helper,
      );
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof ApiError ? error.status : 400,
        error: String(error instanceof Error ? error.message : error).slice(0, 2000),
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  shutdown() {
    return this.runtime.shutdown();
  }
}
