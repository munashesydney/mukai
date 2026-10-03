import { createServer } from 'node:http';

/** A separate, short-lived listener: callbacks do not bypass Mukai's API auth. */
export async function listenForOAuth(callback: (url: URL) => Promise<void>) {
  const server = createServer((request, response) => {
    const address = server.address();
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    const url = new URL(request.url || '/', `http://${host}`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      request.method !== 'GET' ||
      request.headers.host !== host ||
      url.pathname !== '/auth/callback'
    ) {
      response.writeHead(404).end('Not found.');
      return;
    }
    void callback(url).then(
      () => response.end('ChatGPT sign-in finished. Return to Mukai.'),
      () =>
        response.writeHead(400).end('Sign-in could not be completed. Return to Mukai for details.'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start sign-in callback.');
  return { uri: `http://127.0.0.1:${address.port}/auth/callback`, close: () => server.close() };
}
