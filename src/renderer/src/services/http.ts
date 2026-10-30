import type { DesktopBridge } from '../../../shared/contracts';
import { authChanged } from './ownerAuthService';
import {
  diagnoseNonJsonResponse,
  diagnoseTransportFailure,
  originBlockedMessage,
  type ConnectionTarget,
} from './connectionDiagnostics';
import { isCancellation } from '../utils/errors';

let connection: Promise<{ url: string; token: string }> | undefined;

/**
 * Where renderer API calls go: the desktop bridge's server, else same-origin `/api`.
 *
 * The answer is asked for once and reused, because every request needs it and the
 * bridge call is an IPC round trip. What must not be reused is a *failure*: an
 * app whose server had not finished starting (or whose IPC handler was not
 * installed yet) rejects, and a cached rejection would aim every later poll at
 * nothing forever — the banner would survive the backend coming up, and only a
 * full reload could clear it. A failed lookup is therefore dropped so the next
 * retry asks the bridge again.
 */
async function resolveConfig(): Promise<{ url: string; token: string }> {
  const bridge = window.mukai as DesktopBridge | undefined;
  if (!bridge) return { url: '/api', token: '' };
  if (!connection) {
    const asked = bridge.getApiConnection();
    connection = asked;
    asked.catch(() => {
      if (connection === asked) connection = undefined;
    });
  }
  return connection;
}

/**
 * The address a request for `path` is really aimed at.
 *
 * `path` is relative by design — the page reaches the API under `/api` — which
 * is exactly what made every connection failure unreadable: the message could
 * not name a port the user had never written down. Resolving it here lets a
 * diagnosis say `http://127.0.0.1:47831` instead of "the server".
 */
export async function apiTarget(path: string): Promise<ConnectionTarget> {
  const raw = (await resolveConfig()).url + path;
  return { raw, url: absolute(raw) };
}

function absolute(raw: string): URL | undefined {
  try {
    const base = (globalThis as { window?: { location?: { href?: string } } }).window?.location
      ?.href;
    return new URL(raw, base);
  } catch {
    // A page with no document base (or an unusable path) still gets a usable
    // message; it just cannot be narrowed to an origin.
    return undefined;
  }
}

export async function apiWebSocketUrl(path: string) {
  const config = await resolveConfig();
  const url = new URL(config.url + path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Last answer per polled path, so a body-less 304 can be served without
 * re-reading or re-parsing megabytes of unchanged JSON. Entries are keyed by the
 * exact path (query included) and the server decides identity, so a mutation
 * that changes a read's content simply produces a new ETag on the next poll.
 */
const MAX_REVALIDATED = 16;
const revalidated = new Map<string, { etag: string; value: unknown }>();

/** Map insertion order doubles as recency order. */
function remember(path: string, entry: { etag: string; value: unknown }) {
  revalidated.delete(path);
  revalidated.set(path, entry);
  while (revalidated.size > MAX_REVALIDATED) {
    const oldest = revalidated.keys().next().value;
    if (oldest === undefined) break;
    revalidated.delete(oldest);
  }
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const bridge = window.mukai as DesktopBridge | undefined;
  const config = await resolveConfig();
  const headers = new Headers(init.headers);
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  if ((init.method || 'GET').toUpperCase() === 'GET') {
    const held = revalidated.get(path);
    // Holding a validator turns "send this to me again" into "has this changed?".
    if (held) headers.set('If-None-Match', held.etag);
  }
  let response: Response;
  try {
    response = await fetch(config.url + path, { ...init, headers, cache: 'no-store' });
  } catch (error) {
    // A cancellation is the one rejection that says nothing about the server. A page
    // that navigated, a view that unmounted, or a caller that aborted its own signal
    // all land here, and labelling them "start the backend" raised a false banner over
    // a server that was answering every other poll fine. Let it through unchanged so
    // callers can recognise it (see isCancellation).
    if (isCancellation(error)) throw error;
    // A poll that fails here is retried every second, so this text is what the
    // user stares at while the banner is up. It has to name the address and the
    // kind of failure: an address that is unreachable while a backend runs
    // elsewhere needs a different repair from a stopped backend, and the old
    // wording blamed the backend either way.
    throw new Error(
      diagnoseTransportFailure(await apiTarget(path), (error as Error | undefined)?.cause ?? error),
    );
  }
  // 304 is the successful answer to a revalidation, and carries no body to read.
  if (!response.ok && response.status !== 304) {
    if (response.status === 401 && !bridge && !import.meta.env.DEV)
      window.dispatchEvent(new Event(authChanged));
    const text = await response.text().catch(() => '');
    const detail = parseJson<{ error?: string }>(text);
    if (detail?.error) throw new Error(detail.error);
    // A body that is not Mukai's error shape means something other than the
    // server answered, and a 403 with nothing to say is the signature of a page
    // whose origin the server refuses. Both need the address named, because both
    // survive a refresh and neither blames the right thing otherwise.
    const target = await apiTarget(path);
    if (response.status === 403) {
      throw new Error(originBlockedMessage(target) ?? `The request failed (${response.status}).`);
    }
    if (text.trim() && !detail) {
      throw new Error(
        diagnoseNonJsonResponse({
          target,
          status: response.status,
          bodyText: text,
          contentType: response.headers.get('Content-Type'),
        }),
      );
    }
    throw new Error(`The request failed (${response.status}).`);
  }
  return response;
}

export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method,
    ...(value === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  });
  if (response.status === 304) {
    const held = revalidated.get(path);
    // Returning the same reference is what lets callers skip a rebuild outright.
    if (held) return held.value as T;
    // The validator outlived its body (evicted mid-flight); re-read without it.
    return (await (await apiFetch(path, { method })).json()) as T;
  }
  const text = await response.text();
  const parsed = parseJson<T>(text);
  // Mukai's own responses carry no Content-Type, so only a failed parse counts
  // as a non-JSON answer. HTML here means whatever serves this page answered an
  // /api path itself, and "Unexpected token '<'" is not something a user can act
  // on; the address and what came back are.
  if (parsed === undefined) {
    throw new Error(
      diagnoseNonJsonResponse({
        target: await apiTarget(path),
        status: response.status,
        bodyText: text,
        contentType: response.headers.get('Content-Type'),
      }),
    );
  }
  const etag = response.headers.get('ETag');
  if (etag) remember(path, { etag, value: parsed });
  else revalidated.delete(path);
  return parsed;
}

/** Parses Mukai's JSON, or returns undefined for a body that is not JSON. */
function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
