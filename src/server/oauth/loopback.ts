import { createServer } from 'node:http';

/** A separate, short-lived listener: callbacks do not bypass Mukai's API auth. */
export async function listenForOAuth(callback: (url: URL) => Promise<void>) {
  // Keep the bound address: server.address() becomes null during shutdown,
  // even though requests on an existing browser connection can still arrive.
  let host = '';
  let closing = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (closing) {
      response.setHeader('Connection', 'close');
      response.writeHead(410).end('Sign-in listener has closed. Return to Mukai.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url || '/', `http://${host}`);
    } catch {
      response.writeHead(400).end('Invalid callback URL.');
      return;
    }
    if (
      request.method !== 'GET' ||
      request.headers.host !== host ||
      url.origin !== `http://${host}` ||
      url.pathname !== '/auth/callback'
    ) {
      response.writeHead(404).end('Not found.');
      return;
    }
    let completion: Promise<void>;
    try {
      completion = callback(url);
    } catch {
      response.writeHead(400).end('Sign-in could not be completed. Return to Mukai for details.');
      return;
    }
    void completion.then(
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
  host = `127.0.0.1:${address.port}`;
  return {
    uri: `http://${host}/auth/callback`,
    close: () => {
      if (closing) return;
      closing = true;
      server.close();
    },
  };
}
