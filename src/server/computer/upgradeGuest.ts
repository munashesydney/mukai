import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Computer } from './protocol';
import { guestFiles } from './bundleFiles';

/** App-owned maintenance through the existing guest bridge; never executes on the host. */
export async function upgradeGuest(
  bundleDir: string,
  request: Computer['request'],
  signal: AbortSignal,
  onProgress?: (output: string) => void,
) {
  const names = guestFiles.filter((name) => name !== 'install.sh');
  const files = Object.fromEntries(
    await Promise.all(
      names.map(
        async (name) => [name, (await readFile(join(bundleDir, name))).toString('base64')] as const,
      ),
    ),
  );
  const script = [
    'import sys,json,tempfile,pathlib,base64,subprocess,shutil',
    'files=json.loads(sys.stdin.readline())',
    'directory=tempfile.mkdtemp(prefix="mukai-update-")',
    'try:',
    ' for name,data in files.items():',
    '  if name not in ' + JSON.stringify(names) + ': raise ValueError("Invalid update file")',
    '  pathlib.Path(directory,name).write_bytes(base64.b64decode(data,validate=True))',
    ' subprocess.run(["sudo","-n","/bin/sh",directory+"/protect.sh",directory],check=True)',
    'finally: shutil.rmtree(directory)',
  ].join('\n');
  const owner = {
    workspaceId: 'mukai-maintenance',
    botId: 'mukai-maintenance',
    conversationId: 'guest-upgrade',
  };
  const result = z.object({ id: z.string().uuid() }).parse(
    await request(
      'terminal',
      {
        command: "python3 -c '" + script + "'",
        background: true,
        timeoutSeconds: 1200,
      },
      owner,
      signal,
    ),
  );
  const payload = JSON.stringify(files) + '\n';
  try {
    for (let offset = 0; offset < payload.length; offset += 12000) {
      await request(
        'process',
        { action: 'write', sessionId: result.id, text: payload.slice(offset, offset + 12000) },
        owner,
        signal,
      );
    }
    const stateSchema = z.object({
      status: z.string(),
      exitCode: z.number().nullable(),
      output: z.string(),
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = stateSchema.parse(
        await request(
          'process',
          { action: 'wait', sessionId: result.id, waitMs: 30000 },
          owner,
          signal,
        ),
      );
      onProgress?.(state.output.slice(-2000));
      if (state.status !== 'running') {
        if (state.exitCode !== 0)
          throw new Error('Guest update failed: ' + state.output.slice(-4000));
        return;
      }
    }
    throw new Error('Guest update timed out.');
  } finally {
    if (!signal.aborted)
      await request('process', { action: 'kill', sessionId: result.id }, owner, signal).catch(
        () => {},
      );
  }
}
