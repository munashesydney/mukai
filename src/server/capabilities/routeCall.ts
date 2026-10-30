import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from 'zod';
import { ApiError } from '../config';
import type { CapabilityDefinition, CustomRequest } from '../../shared/customCapabilities';

export const MAX_ROUTE_CALL_DEPTH = 4;
export const MAX_ROUTE_CALLS = 16;
export interface RouteCallChain {
  ancestors: string[];
  budget: { remaining: number };
}
const routeRequest = z
  .object({
    body: z.unknown().optional(),
    rawBody: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.string()).default({}),
  })
  .strict();

/** Build the same request contract as HTTP ingress, without sending HTTP or credentials. */
export function routeCallRequest(definition: CapabilityDefinition, raw: unknown): CustomRequest {
  const input = routeRequest.parse(raw ?? {});
  if (Buffer.byteLength(JSON.stringify(input)) > 262144)
    throw new ApiError(413, 'Route call request exceeds 256 KB.');
  if (input.rawBody !== undefined && input.body !== undefined)
    throw new ApiError(400, 'Choose body or rawBody, not both.');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const key = name.toLowerCase();
    if (
      /^(host|connection|transfer-encoding|content-length|upgrade|keep-alive|proxy-authenticate|proxy-authorization|trailer)$/.test(
        key,
      )
    )
      throw new ApiError(400, 'Route call includes a reserved HTTP header.');
    if (key in headers) throw new ApiError(400, 'Route call includes duplicate header names.');
    if (
      ['mukai', 'session'].includes(definition.auth || '') &&
      (key === 'authorization' || (definition.auth === 'session' && key === 'cookie'))
    )
      continue;
    headers[key] = value;
  }
  const rawBody = Buffer.from(
    input.rawBody ?? (input.body === undefined ? '' : JSON.stringify(input.body)),
  );
  if (input.body !== undefined && !headers['content-type'])
    headers['content-type'] = 'application/json';
  let body: unknown;
  if (/^application\/json\b/i.test(headers['content-type'] || '') && rawBody.length) {
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      /* Preserve exact signed bytes. */
    }
  }
  const query = new URLSearchParams(input.query).toString();
  return {
    method: definition.method!,
    url: definition.path! + (query ? '?' + query : ''),
    headers,
    rawBody,
    body,
  };
}
