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
      // agetty resets ttyS0 when it starts and can break a running installer's stdout.
      bootcmd: [['systemctl', 'mask', '--now', 'serial-getty@ttyS0.service']],
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
          'cd /opt/mukai-bootstrap || exit 1; sh install.sh > /var/log/mukai-setup.log 2>&1 & installer=$!; tail -n +1 -f /var/log/mukai-setup.log > /dev/ttyS0 2>/dev/null & logger=$!; if wait "$installer" && touch /etc/cloud/cloud-init.disabled; then result=MUKAI_IMAGE_READY; else result=MUKAI_IMAGE_FAILED; fi; kill "$logger" 2>/dev/null || true; tail -n 60 /var/log/mukai-setup.log > /dev/ttyS0; echo "$result" > /dev/ttyS0; sync; if [ -x /usr/lib/mukai-guest/systemctl ]; then /usr/lib/mukai-guest/systemctl poweroff; else poweroff; fi',
        ],
      ],
      output: { all: '| tee -a /var/log/cloud-init-output.log /dev/console' },
    }) +
    '\n'
  );
}
export async function setupSeed(bundleDir: string) {
  const files = Object.fromEntries(
    await Promise.all(
      [
        'guest.cjs',
        'guest-worker.cjs',
        'package.json',
        'install.sh',
        'protect.sh',
        'systemctl-guard.sh',
        'mukai-guest.service',
      ].map(async (name) => [name, await readFile(join(bundleDir, name))] as const),
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
