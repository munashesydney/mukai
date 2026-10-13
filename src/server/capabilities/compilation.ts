import { readFileSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { WorkspaceFileService } from '../services/workspaceFileService';
import { buildCapability } from './compiler';

/** Resolve and bundle dependencies on the computer owning the workspace files. */
export async function compileWorkspaceCapability(
  folder: string,
  privateDir: string,
  modulePath: string,
  signal?: AbortSignal,
) {
  const files = new WorkspaceFileService(folder, privateDir);
  const entry = (await files.path(modulePath)).absolute;
  signal?.throwIfAborted();
  const source = readFileSync(entry, 'utf8');
  if (Buffer.byteLength(source) > 262144) throw new Error('Module exceeds 256 KB.');
  const sources: Record<string, string> = {};
  const compiled = await buildCapability({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    logLevel: 'silent',
    metafile: true,
    plugins: [
      {
        name: 'workspace-sources',
        setup: (api) => {
          api.onLoad({ filter: /.*/ }, async (args) => {
            const local = relative(folder, args.path);
            if (isAbsolute(local) || local.split(/[\\/]/)[0] === '..')
              throw new Error('Dependencies must be installed inside the workspace.');
            if (!local.split(/[\\/]/).includes('node_modules')) {
              await files.path(local);
              const text = readFileSync(args.path, 'utf8');
              if (Buffer.byteLength(text) > 262144) throw new Error('Source file exceeds 256 KB.');
              sources[local] = text;
            }
            return undefined;
          });
        },
      },
    ],
  });
  const output = compiled.outputFiles?.[0]?.text;
  if (!output || Buffer.byteLength(output) > 10 * 1024 * 1024)
    throw new Error('Compiled module exceeds 10 MB.');

  signal?.throwIfAborted();
  // Keep the full compilation response within the bridge's byte limit.
  if (Buffer.byteLength(JSON.stringify(sources)) > 10 * 1024 * 1024)
    throw new Error('Source snapshots exceed 10 MB.');
  return { output, source, sources };
}
