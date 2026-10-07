import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** No ISO tooling needed: NoCloud reads a temporary, token-scoped host endpoint. */
export function cloudConfig(files: Record<string, Buffer>) {
  return (
    '#cloud-config\n' +
    JSON.stringify({
      hostname: 'mukai',
      manage_etc_hosts: true,
      write_files: Object.entries(files).map(([name, bytes]) => ({
        path: '/opt/mukai-bootstrap/' + name,
        encoding: 'b64',
        content: bytes.toString('base64'),
        permissions: '0600',
      })),
      runcmd: [
        [
          'sh',
          '-c',
          'cd /opt/mukai-bootstrap && sh install.sh > /dev/ttyS0 2>&1 && touch /etc/cloud/cloud-init.disabled && sync && echo MUKAI_IMAGE_READY > /dev/ttyS0 && poweroff',
        ],
      ],
      output: { all: '| tee -a /var/log/cloud-init-output.log /dev/ttyS0' },
    }) +
    '\n'
  );
}
export async function setupSeed(bundleDir: string) {
  const files = Object.fromEntries(
    await Promise.all(
      ['guest.cjs', 'package.json', 'install.sh', 'mukai-guest.service'].map(
        async (name) => [name, await readFile(join(bundleDir, name))] as const,
      ),
    ),
  );
  const userData = cloudConfig(files);
  const token = randomBytes(32).toString('hex');
  const prefix = '/' + token + '/';
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url?.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const name = request.url.slice(prefix.length);
    response.setHeader('Content-Type', 'text/plain');
    response.setHeader('Cache-Control', 'no-store');
    if (name === 'user-data') response.end(userData);
    else if (name === 'meta-data')
      response.end(
        JSON.stringify({ 'instance-id': 'mukai-base-' + token, 'local-hostname': 'mukai' }),
      );
    else if (name === 'vendor-data') response.end('{}');
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not start the Linux image setup endpoint.');
  return {
    port: address.port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
