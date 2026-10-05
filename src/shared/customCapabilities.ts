/** Authoring contract for real .ts/.js capability modules. Imports may be type-only. */
export interface CapabilityContext {
  env: Record<string, string>;
  signal: AbortSignal;
  workspaceId: string;
  /** Commit a job before acknowledging a webhook. Duplicate event IDs return the same job. */
  enqueue(
    provider: string,
    eventId: string,
    payload: unknown,
  ): Promise<{ id: string; duplicate: boolean }>;
  /** Queue a model run for botId, or the registration's owner when omitted. */
  wakeBot(message: string, options?: { botId?: string }): Promise<{ accepted: boolean }>;
}
export interface CustomToolModule {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredEnv?: string[];
  timeoutMs?: number;
  execute(args: unknown, context: CapabilityContext): Promise<unknown> | unknown;
}
export interface CustomRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Uint8Array;
  body?: unknown;
}
export interface CustomResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface CustomRouteModule {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  /** handler: verify the provider signature before work/enqueue; public: explicitly unauthenticated. */
  auth: 'mukai' | 'handler' | 'public';
  requiredEnv?: string[];
  timeoutMs?: number;
  handle(
    request: CustomRequest,
    context: CapabilityContext,
  ): Promise<CustomResponse> | CustomResponse;
  processJob?(payload: unknown, context: CapabilityContext): Promise<unknown> | unknown;
}
export interface CapabilityDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  method?: string;
  path?: string;
  auth?: CustomRouteModule['auth'];
  requiredEnv: string[];
  timeoutMs: number;
  hasJobHandler: boolean;
}
export interface CapabilityRegistration {
  id: string;
  workspaceId: string;
  ownerBotId: string | null;
  kind: 'tool' | 'route';
  modulePath: string;
  exportName: string;
  version: string;
  enabled: boolean;
  definition: CapabilityDefinition;
  status: 'ready' | 'disabled' | 'needs_configuration' | 'invalid';
  missingEnv: string[];
  error: string | null;
  url?: string;
}
export interface CapabilityRun {
  id: string;
  version: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  error: string | null;
}
export interface EnvironmentVariable {
  name: string;
  configured: boolean;
  usedBy: string[];
}
