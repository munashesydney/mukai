import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import { ApiError, privateSecret } from '../config';
import type { ProviderRepository } from '../repositories/providerRepository';
import type { DiagnosticService } from './diagnosticService';
import type { ChatGPTSignIn, ProviderModel } from '../../shared/ai';
import type { ProviderRecord } from '../models/entities';
import { listenForOAuth } from '../oauth/loopback';
import { chatGPTError, chatGPTRequest, collectChatGPTResponse } from './chatgptTransport';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
interface Credentials {
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
}
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  earliest_refresh_at?: number;
  scope?: string;
}
interface Attempt {
  result: ChatGPTSignIn;
  providerId?: string;
  state: string;
  nonce: string;
  verifier: string;
  close: () => void;
  timer?: ReturnType<typeof setTimeout>;
  claimed: boolean;
  clientId?: string;
}

export function classifyChatGPTModel(id: string): ProviderModel['category'] {
  if (/codex/i.test(id)) return 'Codex';
  if (/^o\d(?:-|$)/i.test(id)) return 'Reasoning';
  if (/^gpt-/i.test(id)) return 'GPT';
  return 'Other';
}

export class ChatGPTService {
  private attempts = new Map<string, Attempt>();
  private refreshes = new Map<string, Promise<string>>();
  private hostId: string;
  private requests = new Map<string, Set<AbortController>>();
  private signingOut = new Set<string>();
  private disconnecting = new Set<string>();
  constructor(
    private providers: ProviderRepository,
    dir: string,
    private encrypt: (text: string) => string,
    private decrypt: (text: string | null) => string | undefined,
    private diagnostics: DiagnosticService,
    private request: typeof fetch = fetch,
  ) {
    // Persist once, independent of accounts and provider deletion.
    const bytes = privateSecret(dir, 'chatgpt.host', 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    this.hostId = `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  private credentials(id: string) {
    const provider = this.providers.find(id);
    if (!provider || provider.kind !== 'chatgpt')
      throw new ApiError(404, 'ChatGPT connection not found.');
    const text = this.decrypt(provider.encryptedKey);
    if (!text) throw new ApiError(401, 'Connect your ChatGPT account in Settings.');
    const credentials = JSON.parse(text) as Credentials;
    for (const secret of [credentials.accessToken, credentials.refreshToken, credentials.idToken])
      this.diagnostics.registerSecret(secret);
    return credentials;
  }
  describe(provider: ProviderRecord) {
    const credentials = this.credentials(provider.id);
    return {
      label: `${credentials.email || credentials.name || 'ChatGPT account'} · ${credentials.clientId.slice(-8)}`,
      clientId: credentials.clientId,
      connected: Boolean(credentials.accessToken),
      planEnabled: credentials.scopes.includes('chatgpt.tokens.use.direct'),
    };
  }
  private save(id: string, credentials: Credentials) {
    const provider = this.providers.find(id);
    if (!provider) throw new ApiError(409, 'This connection was removed.');
    for (const secret of [credentials.accessToken, credentials.refreshToken, credentials.idToken])
      this.diagnostics.registerSecret(secret);
    this.providers.save({ ...provider, encryptedKey: this.encrypt(JSON.stringify(credentials)) });
  }
  private async fetchJSON(url: string, init: RequestInit = {}) {
    const response = await this.request(url, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.error === 'string' ? payload.error : '';
      throw Object.assign(
        new ApiError(
          response.status,
          'OpenAI could not complete the account request. Try again or reconnect in Settings.',
        ),
        { code },
      );
    }
    return payload;
  }
  private async discovery() {
    const value = await this.fetchJSON(`${issuer}/.well-known/openid-configuration`);
    if (value.issuer !== issuer) throw new ApiError(502, 'OpenAI identity issuer did not match.');
    for (const key of ['jwks_uri', 'revocation_endpoint']) {
      const url = new URL(String(value[key]));
      if (url.origin !== issuer || url.username || url.password || url.hash)
        throw new ApiError(502, 'OpenAI identity configuration was not trusted.');
    }
    return value;
  }
  private async identity(token: string, clientId: string, nonce: string) {
    const pieces = token.split('.');
    if (pieces.length !== 3) throw new ApiError(400, 'Invalid OpenAI identity token.');
    const header = JSON.parse(Buffer.from(pieces[0], 'base64url').toString()) as {
      alg: string;
      kid: string;
    };
    if (!['RS256', 'ES256'].includes(header.alg))
      throw new ApiError(400, 'Unsupported identity signature.');
    const configuration = await this.discovery();
    const jwks = await this.fetchJSON(String(configuration.jwks_uri));
    const keys = jwks.keys as (JsonWebKey & { kid?: string; alg?: string; use?: string })[];
    const jwk = keys?.find(
      (key) =>
        key.kid === header.kid &&
        (!key.alg || key.alg === header.alg) &&
        (!key.use || key.use === 'sig') &&
        key.kty === (header.alg === 'RS256' ? 'RSA' : 'EC'),
    );
    if (
      !jwk ||
      !verify(
        'sha256',
        Buffer.from(`${pieces[0]}.${pieces[1]}`),
        {
          key: createPublicKey({ key: jwk, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(pieces[2], 'base64url'),
      )
    )
      throw new ApiError(400, 'OpenAI identity signature did not match.');
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString()) as {
      iss: string;
      aud: string | string[];
      azp?: string;
      exp: number;
      nbf?: number;
      nonce: string;
      sub: string;
      email?: string;
      name?: string;
    };
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== issuer ||
      !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000 ||
      (claims.nbf !== undefined && claims.nbf > Date.now() / 1000 + 30) ||
      claims.nonce !== nonce ||
      !claims.sub
    )
      throw new ApiError(400, 'OpenAI identity validation failed. Start sign-in again.');
    return claims;
  }
  private async token(parameters: Record<string, string>) {
    const value = (await this.fetchJSON(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
    })) as unknown as TokenResponse;
    if (
      typeof value.access_token !== 'string' ||
      !value.access_token ||
      typeof value.token_type !== 'string' ||
      value.token_type.toLowerCase() !== 'bearer' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      (value.scope !== undefined && typeof value.scope !== 'string') ||
      (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') ||
      (value.id_token !== undefined && typeof value.id_token !== 'string')
    )
      throw new ApiError(502, 'OpenAI returned incomplete credentials. Start sign-in again.');
    for (const secret of [value.access_token, value.refresh_token, value.id_token])
      this.diagnostics.registerSecret(secret);
    return value;
  }
  async begin(providerId?: string, consent = false, retryAttemptId?: string) {
    if (providerId && this.disconnecting.has(providerId))
      throw new ApiError(409, 'Wait for ChatGPT sign-out to finish before reconnecting.');
    for (const attempt of this.attempts.values())
      if (attempt.result.status === 'pending' && attempt.providerId === providerId)
        this.cancel(attempt.result.id);
    const previous = providerId ? this.credentials(providerId) : undefined;
    const retry = retryAttemptId ? this.attempts.get(retryAttemptId) : undefined;
    const registeredClient =
      previous?.clientId ||
      (retry?.providerId === providerId && retry?.result.status === 'failed'
        ? retry.clientId
        : undefined);
    const id = randomUUID();
    const attempt: Attempt = {
      result: { id, status: 'pending' },
      providerId,
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      close: () => {},
      claimed: false,
    };
    const listener = await listenForOAuth(async (url) => {
      // Invalid callbacks must not consume a valid pending attempt.
      if (
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== attempt.state ||
        attempt.claimed ||
        attempt.result.status !== 'pending'
      )
        throw new ApiError(400, 'Invalid sign-in callback.');
      attempt.claimed = true;
      try {
        if (url.searchParams.has('error'))
          throw new ApiError(400, 'ChatGPT sign-in was declined. You can try again.');
        if (url.searchParams.getAll('client_id').length > 1)
          throw new ApiError(400, 'Ambiguous ChatGPT registration.');
        const clientId = url.searchParams.get('client_id') || registeredClient;
        if (
          !clientId ||
          clientId === 'dynamic_agent_client' ||
          (previous && clientId !== previous.clientId)
        )
          throw new ApiError(400, 'ChatGPT registration did not match. Start sign-in again.');
        if (registeredClient && clientId !== registeredClient)
          throw new ApiError(400, 'ChatGPT registration changed. Start a new connection.');
        attempt.clientId = clientId;
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.getAll('code').length !== 1)
          throw new ApiError(400, 'Missing sign-in code.');
        const tokens = await this.token({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: attempt.verifier,
          redirect_uri: listener.uri,
          resource,
        });
        if (!tokens.id_token) throw new ApiError(400, 'Missing OpenAI identity token.');
        const identity = await this.identity(tokens.id_token, clientId, attempt.nonce);
        if (previous && identity.sub !== previous.subject)
          throw new ApiError(
            400,
            'A different ChatGPT account signed in. Add it as a separate connection.',
          );
        if (attempt.result.status !== 'pending')
          throw new ApiError(400, 'This sign-in attempt ended.');
        const credentials: Credentials = {
          clientId,
          subject: identity.sub,
          email: identity.email,
          name: identity.name,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          earliestRefreshAt: tokens.earliest_refresh_at,
          scopes: (tokens.scope || '').split(' ').filter(Boolean),
        };
        const connectionId =
          providerId ||
          this.providers
            .list()
            .find(
              (provider) =>
                provider.kind === 'chatgpt' &&
                this.credentials(provider.id).clientId === clientId &&
                this.credentials(provider.id).subject === identity.sub,
            )?.id ||
          randomUUID();
        if (!this.providers.find(connectionId))
          this.providers.save({
            id: connectionId,
            name: 'ChatGPT',
            kind: 'chatgpt',
            baseUrl: '',
            defaultModel: '',
            supportsImages: false,
            isDefault: !this.providers.list().length,
            encryptedKey: this.encrypt(JSON.stringify(credentials)),
            contextWindowTokens: null,
            maxOutputTokens: 8192,
          });
        else this.save(connectionId, credentials);
        this.signingOut.delete(connectionId);
        attempt.result = {
          id,
          status: 'complete',
          providerId: connectionId,
          message: credentials.scopes.includes('chatgpt.tokens.use.direct')
            ? 'ChatGPT connected. Choose a model to finish setup.'
            : 'Signed in. ChatGPT plan usage was not enabled; enable it before chatting.',
        };
      } catch (error) {
        if (attempt.result.status === 'pending')
          attempt.result = {
            id,
            status: 'failed',
            message:
              error instanceof ApiError ? error.message : 'ChatGPT sign-in failed. Start again.',
          };
        throw error;
      } finally {
        listener.close();
        clearTimeout(attempt.timer);
      }
    });
    attempt.close = listener.close;
    attempt.timer = setTimeout(
      () => {
        this.cancel(id);
        attempt.result = { id, status: 'failed', message: 'ChatGPT sign-in expired. Start again.' };
      },
      5 * 60 * 1000,
    );
    attempt.timer.unref();
    // Bound retained polling results.
    for (const [key, value] of this.attempts)
      if (this.attempts.size >= 20 && value.result.status !== 'pending') this.attempts.delete(key);
    this.attempts.set(id, attempt);
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: registeredClient || 'dynamic_agent_client',
      ...(registeredClient ? {} : { agent_name_hint: 'Mukai' }),
      ext_agent_host_id: this.hostId,
      response_type: 'code',
      redirect_uri: listener.uri,
      scope: scopes,
      resource,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      ...(previous?.idToken ? { id_token_hint: previous.idToken } : {}),
      ...(previous?.email ? { login_hint: previous.email } : {}),
      ...(consent ? { prompt: 'consent' } : {}),
    }).toString();
    return { ...attempt.result, url: url.href };
  }
  status(id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new ApiError(404, 'Sign-in attempt not found. Start again.');
    return attempt.result;
  }
  cancel(id: string) {
    const attempt = this.attempts.get(id);
    if (attempt?.result.status === 'pending') {
      attempt.result = { id, status: 'cancelled' };
      attempt.close();
      clearTimeout(attempt.timer);
    }
  }
  cancelForProvider(id: string) {
    for (const attempt of this.attempts.values())
      if (attempt.providerId === id) this.cancel(attempt.result.id);
  }
  shutdown() {
    for (const id of this.attempts.keys()) this.cancel(id);
    for (const requests of this.requests.values())
      for (const controller of requests) controller.abort();
  }
  async disconnect(id: string) {
    if (this.disconnecting.has(id))
      throw new ApiError(409, 'ChatGPT sign-out is already in progress.');
    this.disconnecting.add(id);
    try {
      return await this.endSession(id);
    } finally {
      this.disconnecting.delete(id);
    }
  }
  private async endSession(id: string) {
    this.signingOut.add(id);
    for (const controller of this.requests.get(id) || []) controller.abort();
    this.cancelForProvider(id);
    // Drain any rotating refresh before revocation.
    await this.refreshes.get(id)?.catch(() => {});
    const credentials = this.credentials(id);
    let revoked = !credentials.refreshToken;
    try {
      if (credentials.refreshToken) {
        const configuration = await this.discovery();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await this.request(String(configuration.revocation_endpoint), {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(10000),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: credentials.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: credentials.clientId,
              }),
            });
            revoked = response.ok;
            if (response.ok || response.status < 500) break;
          } catch {
            if (attempt === 1) break;
          }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } catch {
      /* Local sign-out still clears credentials. */
    }
    this.save(id, {
      ...credentials,
      accessToken: undefined,
      refreshToken: undefined,
      idToken: undefined,
      expiresAt: 0,
    });
    return {
      ok: true,
      message: revoked
        ? 'ChatGPT disconnected.'
        : 'Disconnected on this device. Remote revocation was not confirmed; disconnect Mukai in ChatGPT Settings too.',
    };
  }
  async accessToken(id: string): Promise<string> {
    if (this.signingOut.has(id))
      throw new ApiError(401, 'Reconnect your ChatGPT account in Settings.');
    const credentials = this.credentials(id);
    if (!credentials.scopes.includes('chatgpt.tokens.use.direct'))
      throw new ApiError(403, 'Enable ChatGPT plan usage for this account in Settings.');
    if (!credentials.accessToken)
      throw new ApiError(401, 'Reconnect your ChatGPT account in Settings.');
    if (credentials.expiresAt > Date.now() + 60000) return credentials.accessToken;
    const active = this.refreshes.get(id);
    if (active) return active;
    const promise = this.refresh(id, credentials).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, promise);
    return promise;
  }
  private async refresh(id: string, credentials: Credentials) {
    if (!credentials.refreshToken)
      throw new ApiError(401, 'ChatGPT access expired. Reconnect in Settings.');
    if (credentials.earliestRefreshAt && credentials.earliestRefreshAt * 1000 > Date.now()) {
      if (credentials.expiresAt > Date.now()) return credentials.accessToken!;
      throw new ApiError(503, 'ChatGPT access cannot be renewed yet. Try again shortly.');
    }
    try {
      const tokens = await this.token({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
        resource,
      });
      if (this.credentials(id).refreshToken !== credentials.refreshToken)
        throw new ApiError(409, 'ChatGPT connection changed during renewal. Retry.');
      const next = {
        ...credentials,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        idToken: tokens.id_token || credentials.idToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        earliestRefreshAt: tokens.earliest_refresh_at,
        scopes:
          tokens.scope === undefined ? credentials.scopes : tokens.scope.split(' ').filter(Boolean),
      };
      this.save(id, next);
      if (!next.scopes.includes('chatgpt.tokens.use.direct'))
        throw new ApiError(403, 'ChatGPT plan usage is disabled. Enable it in Settings.');
      return next.accessToken;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code &&
        [
          'invalid_grant',
          'invalid_refresh_token',
          'token_expired',
          'refresh_token_expired',
          'refresh_token_invalidated',
          'refresh_token_reused',
        ].includes(code)
      ) {
        if (this.credentials(id).refreshToken === credentials.refreshToken)
          this.save(id, {
            ...credentials,
            accessToken: undefined,
            refreshToken: undefined,
            idToken: undefined,
            expiresAt: 0,
          });
        throw new ApiError(401, 'ChatGPT access expired or was revoked. Reconnect in Settings.');
      }
      throw error;
    }
  }
  async models(id: string): Promise<ProviderModel[]> {
    const token = await this.accessToken(id);
    const payload = await this.fetchJSON(`${resource}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const models = payload.models;
    if (!Array.isArray(models))
      throw new ApiError(502, 'OpenAI returned an invalid model catalog.');
    const seen = new Set<string>();
    return models.flatMap((model: Record<string, unknown>) => {
      if (!model || typeof model !== 'object') return [];
      if (
        model.visibility !== 'list' ||
        typeof model.slug !== 'string' ||
        !model.slug ||
        model.slug.length > 150 ||
        seen.has(model.slug)
      )
        return [];
      seen.add(model.slug);
      const capacity = model.context_window ?? model.context_window_tokens;
      const modalities = model.input_modalities;
      return [
        {
          id: model.slug,
          name: typeof model.display_name === 'string' ? model.display_name : model.slug,
          category: classifyChatGPTModel(model.slug),
          contextWindowTokens:
            typeof capacity === 'number' &&
            Number.isInteger(capacity) &&
            capacity >= 4096 &&
            capacity <= 10000000
              ? capacity
              : null,
          supportsImages: Array.isArray(modalities)
            ? modalities.includes('image')
            : typeof model.supports_images === 'boolean'
              ? model.supports_images
              : null,
        },
      ];
    });
  }
  fetch(id: string): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      if (
        url !== `${resource}/responses` ||
        init?.method !== 'POST' ||
        typeof init.body !== 'string'
      )
        throw new ApiError(400, 'Unsupported ChatGPT inference route.');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const streaming = body.stream === true;
      const controller = new AbortController();
      const requests = this.requests.get(id) || new Set<AbortController>();
      this.requests.set(id, requests);
      requests.add(controller);
      const cleanup = () => {
        requests.delete(controller);
        if (!requests.size) this.requests.delete(id);
      };
      try {
        const token = await this.accessToken(id);
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        const response = await this.request(url, {
          ...init,
          headers,
          body: JSON.stringify(chatGPTRequest(body)),
          redirect: 'error',
          signal: init.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        });
        if (!response.ok) {
          const responseBody = await response.text();
          let code: string | undefined;
          try {
            code = (JSON.parse(responseBody) as { error?: { code?: string } }).error?.code;
          } catch {
            /* Admission failures can return plain text or detail objects. */
          }
          const message = code
            ? chatGPTError(code)
            : response.status === 401
              ? 'ChatGPT did not accept this account’s authorization. Reconnect the account in Settings.'
              : response.status === 403
                ? 'ChatGPT blocked this request under account, workspace, or serving-region policy. Check the connection and account permissions.'
                : response.status === 503
                  ? 'ChatGPT routing is temporarily unavailable. Your credentials are saved; retry later.'
                  : response.status === 429
                    ? 'Your ChatGPT usage or request limit was reached. Review ChatGPT Settings → Usage, then retry.'
                    : response.status === 404
                      ? 'This model is no longer available. Refresh the ChatGPT model catalog in Settings.'
                      : chatGPTError();
          throw Object.assign(new ApiError(response.status, message), {
            code,
            responseBody,
            requestId: response.headers.get('x-request-id'),
          });
        }
        if (!response.body) {
          cleanup();
          return response;
        }
        if (!streaming) {
          try {
            return await collectChatGPTResponse(response);
          } finally {
            cleanup();
          }
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let terminal = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const { done, value } = await reader.read();
              buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
              if (buffer.length > 32 * 1024 * 1024)
                throw new ApiError(502, 'ChatGPT response event exceeded the supported size.');
              let boundary: number;
              while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = block
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (data && data !== '[DONE]') {
                  const event = JSON.parse(data) as { type: string };
                  if (
                    [
                      'response.completed',
                      'response.incomplete',
                      'response.failed',
                      'error',
                    ].includes(event.type)
                  )
                    terminal = true;
                }
              }
              if (done) {
                cleanup();
                reader.releaseLock();
                if (!terminal)
                  throw new ApiError(
                    502,
                    'ChatGPT’s response was interrupted before completion. Retry when connected.',
                  );
                output.close();
              } else output.enqueue(value);
            } catch (error) {
              cleanup();
              void reader.cancel().catch(() => {});
              output.error(error);
            }
          },
          async cancel(reason) {
            cleanup();
            await reader.cancel(reason);
            reader.releaseLock();
          },
        });
        return new Response(stream, { status: response.status, headers: response.headers });
      } catch (error) {
        cleanup();
        throw error;
      }
    };
  }
}
