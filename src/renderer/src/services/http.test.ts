import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiFetch } from './http';
import {
  diagnoseTransportFailure,
  originBlockedMessage,
  type ConnectionTarget,
} from './connectionDiagnostics';

/**
 * The banner shown when a poll cannot reach the server used to be one fixed
 * sentence blaming the backend, for failures whose repair was anywhere from
 * "start it" to "this page is a stale tab from a dev server that exited". These
 * cover the shapes that were actually observed, each with the detail that makes
 * the message actionable — and, just as importantly, that the repairable paths
 * (revalidation, server-authored errors, same-origin serving) are untouched.
 */

const approvalsPath = '/approvals?workspaceId=bc68b2bc-00d5-48ab-964e-8a51fb1a625c';

/** A browser page served by something other than Mukai's own static host. */
function pageOn(origin: string): void {
  const url = new URL(origin);
  vi.stubGlobal('window', {
    location: { href: `${origin}/approvals`, origin, protocol: url.protocol },
  });
}

/** A desktop window: a file-based document, plus the preload bridge when present. */
function desktopWindow(bridge?: { url: string; token: string }): void {
  vi.stubGlobal('window', {
    location: { href: 'file:///app/out/renderer/index.html', origin: 'null', protocol: 'file:' },
    ...(bridge ? { mukai: { getApiConnection: async () => bridge } } : {}),
  });
}

function rejectedWith(cause: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause });
  });
}

function responds(body: BodyInit | null, init?: ResponseInit) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(body, init));
}

function requestedUrl(fetch: { mock: { calls: unknown[][] } }): string {
  return String(fetch.mock.calls[0]?.[0]);
}

async function failure(message: Promise<unknown>): Promise<string> {
  const reason = await message.catch((error: unknown) => error);
  return reason instanceof Error ? reason.message : String(reason);
}

beforeEach(() => pageOn('http://127.0.0.1:5173'));
afterEach(() => vi.unstubAllGlobals());

describe('transport failures', () => {
  it('names the address and the OS reason when nothing is listening', async () => {
    vi.stubGlobal('fetch', rejectedWith({ code: 'ECONNREFUSED' }));
    const text = await failure(api(approvalsPath));
    expect(text).toMatch(/127\.0\.0\.1:5173/);
    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).toMatch(/mukai serve/);
  });

  it('reads differently when the name itself will not resolve', async () => {
    vi.stubGlobal('fetch', rejectedWith({ code: 'ENOTFOUND' }));
    const text = await failure(api(approvalsPath));
    expect(text).toMatch(/ENOTFOUND/);
    expect(text).toMatch(/resolve/);
  });

  it('says the window has no bridge instead of blaming a backend that is running', async () => {
    desktopWindow();
    vi.stubGlobal('fetch', rejectedWith({ code: 'ERR_INVALID_STATE' }));
    const text = await failure(api(approvalsPath));
    expect(text).toMatch(/no Mukai bridge/i);
    // The old message could not say this, because a relative '/api' resolved
    // against the file document into a path that is not a server at all.
    expect(text).not.toMatch(/file:\/\/\/api/);
  });

  it('reaches the server through the bridge without a false origin warning', async () => {
    desktopWindow({ url: 'http://127.0.0.1:47831', token: 'token' });
    const fetch = responds('{"mode":"none"}');
    vi.stubGlobal('fetch', fetch);
    await expect(api('/approvals?workspaceId=x')).resolves.toEqual({ mode: 'none' });
    expect(requestedUrl(fetch)).toBe('http://127.0.0.1:47831/approvals?workspaceId=x');
  });

  it('lets a cancelled request stay a cancellation instead of blaming the backend', async () => {
    // Browsers abort in-flight fetches when a page navigates or the view that started one
    // unmounts, and a caller sometimes aborts through its own signal. Labelling any of
    // that "start the backend" raised a false banner over a server whose other polls
    // were answering 200 — so the rejection must pass through recognisable.
    const cancelled = Object.assign(new Error('The user aborted a request.'), {
      name: 'AbortError',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () => {
        throw cancelled;
      }),
    );

    await expect(apiFetch(approvalsPath, { signal: AbortSignal.abort() })).rejects.toBe(cancelled);
  });

  it('still blames the server when a request hangs past its deadline', async () => {
    // The opposite case matters just as much: a server that takes the connection and
    // then stops answering is precisely what the banner exists to report.
    vi.stubGlobal(
      'fetch',
      rejectedWith(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })),
    );

    const text = await failure(api(approvalsPath));
    expect(text).toMatch(/Cannot reach Mukai’s server/);
    expect(text).toMatch(/Request timed out/);
    expect(text).toMatch(/mukai serve/);
  });
});

describe('responses that are not Mukai data', () => {
  it('explains a server answering with an HTML page, naming the endpoint', async () => {
    vi.stubGlobal('fetch', responds('<!doctype html><html><body>vite</body></html>'));
    const text = await failure(api(approvalsPath));
    expect(text).toMatch(/HTML page instead of Mukai data/);
    expect(text).toMatch(/\/api\/approvals/);
  });

  it('keeps asking for the relative path so same-origin serving is unchanged', async () => {
    const fetch = responds('{"mode":"none"}');
    vi.stubGlobal('fetch', fetch);
    await api(approvalsPath);
    expect(requestedUrl(fetch)).toBe(`/api${approvalsPath}`);
  });

  it('passes the server’s own error text through unchanged', async () => {
    vi.stubGlobal('fetch', responds('{"error":"Workspace is unavailable"}', { status: 500 }));
    await expect(api(approvalsPath)).rejects.toThrow('Workspace is unavailable');
  });

  it('reports a bodyless rejection by status rather than inventing a cause', async () => {
    pageOn('http://127.0.0.1:47831');
    vi.stubGlobal('fetch', responds('', { status: 403 }));
    await expect(api(approvalsPath)).rejects.toThrow('The request failed (403).');
  });

  it('reuses the held answer for a 304 and keeps sending its validator', async () => {
    let revalidatedWith: string | null = null;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const held = new Headers(init?.headers).get('If-None-Match');
      if (held) {
        revalidatedWith = held;
        return new Response(null, { status: 304 });
      }
      return new Response('{"mode":"ask_bot"}', { headers: { ETag: '"one"' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(api(approvalsPath)).resolves.toEqual({ mode: 'ask_bot' });
    await expect(api(approvalsPath)).resolves.toEqual({ mode: 'ask_bot' });
    expect(revalidatedWith).toBe('"one"');
  });

  it('fails plainly when a 304 has no remembered body to hand back', async () => {
    vi.stubGlobal('fetch', responds(null, { status: 304 }));
    await expect(api('/chat/history?conversationId=never-polled')).rejects.toThrow();
  });
});

describe('apiFetch', () => {
  it('still surfaces a status-only failure to direct callers', async () => {
    desktopWindow({ url: 'http://127.0.0.1:47831', token: 'token' });
    vi.stubGlobal('fetch', responds('', { status: 502 }));
    await expect(apiFetch(approvalsPath)).rejects.toThrow('The request failed (502).');
  });
});

describe('origin trust', () => {
  const foreign: ConnectionTarget = {
    raw: 'http://127.0.0.1:47831/approvals',
    url: new URL('http://127.0.0.1:47831/approvals'),
  };

  it('reports a refused connection even when the page has a different origin', () => {
    pageOn('http://localhost:5273');
    const text = diagnoseTransportFailure(foreign, { code: 'ECONNREFUSED' });
    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).toMatch(/Nothing is listening/);
    expect(text).not.toMatch(/origin.*refused|Open Mukai at/);
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5273'])(
    'does not invent an origin rejection for an opaque transport failure from %s',
    (page) => {
      pageOn(page);
      const text = diagnoseTransportFailure(foreign, new TypeError('Failed to fetch'));
      expect(text).toContain(page);
      expect(text).toContain('http://127.0.0.1:47831');
      expect(text).toMatch(/browser console/i);
      expect(text).not.toMatch(/is refused|refused this page|Open Mukai at/);
    },
  );

  it('preserves DNS failures for cross-origin requests', () => {
    pageOn('http://localhost:5173');
    expect(diagnoseTransportFailure(foreign, { code: 'ENOTFOUND' })).toMatch(/does not resolve/);
  });

  it('does not infer an origin rejection from a bodyless 403', () => {
    pageOn('http://localhost:5173');
    expect(originBlockedMessage(foreign)).toMatch(/403/);
    expect(originBlockedMessage(foreign)).not.toMatch(/refused this page|Open Mukai at/);
  });

  it('stays quiet about origins for a same-origin page', () => {
    pageOn('http://127.0.0.1:47831');
    expect(originBlockedMessage(foreign)).toBeUndefined();
  });

  it('never calls a file-based desktop window cross-origin; it reports the cause instead', () => {
    desktopWindow({ url: 'http://127.0.0.1:47831', token: 'token' });
    expect(originBlockedMessage(foreign)).toBeUndefined();
    expect(diagnoseTransportFailure(foreign, { code: 'ECONNREFUSED' })).toMatch(/ECONNREFUSED/);
  });

  it('describes what it tried even when no page base was available', () => {
    vi.stubGlobal('window', undefined);
    const text = diagnoseTransportFailure({ raw: '/api/approvals' }, { code: 'ECONNREFUSED' });
    expect(text).toMatch(/\/api\/approvals/);
  });
});
