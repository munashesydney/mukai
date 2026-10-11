import { join } from 'node:path';
import { asSchema, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import { z } from 'zod';
import {
  BgeEmbedder,
  MemoryEngine,
  SQLiteMemoryStore,
  extractionInstructions,
  extractionSchema,
  redactCredentials,
  type EpisodeInput,
  type Extractor,
  type MemoryScope,
  type SearchOptions,
  type SQLiteConnection,
} from '../../../mukai_memory/src';
import type { MemorySettings, MemorySnapshot } from '../../shared/memory';
import type { Bot } from '../../shared/ai';
import type { BotRepository } from '../repositories/botRepository';
import type { MessageRepository } from '../repositories/messageRepository';
import type { WorkspaceService } from './workspaceService';
import type { ProviderService } from './providerService';
import { ApiError } from '../config';
import { contextLimits, estimateTokens } from './contextPolicy';
import type { DiagnosticService } from './diagnosticService';
import { PROVIDER_MAX_RETRIES } from './responsePolicy';
import { MemoryReviewService } from './memoryReviewService';

export const memorySettingsSchema = z.object({
  automaticCapture: z.boolean(),
  automaticRecall: z.boolean(),
  semanticSearch: z.boolean(),
  contextTokens: z.number().int().min(256).max(4096),
});
const defaults: MemorySettings = {
  automaticCapture: true,
  automaticRecall: true,
  semanticSearch: false,
  contextTokens: 1600,
};
// Strict structured output requires every declared property to be required.
export const memoryReviewOutputSchema = extractionSchema.extend({
  reviewSummary: z.string().trim().min(1).max(3000),
});

export class MemoryService {
  readonly engine: MemoryEngine;
  readonly store: SQLiteMemoryStore;
  readonly embedding: BgeEmbedder;
  readonly reviews: MemoryReviewService;
  private controller = new AbortController();
  private processing?: Promise<void>;
  private modelTask?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private modelError: string | null = null;
  constructor(
    connection: SQLiteConnection,
    dataDir: string,
    private workspaces: WorkspaceService,
    private bots: BotRepository,
    private providers: ProviderService,
    private messages: MessageRepository,
    extractor?: Extractor,
    private diagnostics?: DiagnosticService,
    reviewIdleMs = 60000,
  ) {
    this.store = new SQLiteMemoryStore(connection);
    this.embedding = new BgeEmbedder(join(dataDir, 'memory-models'));
    this.engine = new MemoryEngine(
      this.store,
      async (request) => {
        const result = await (
          extractor ||
          (async ({ episode, candidates, signal }) => {
            const bot = episode.actorId ? this.bots.find(episode.actorId) : undefined;
            if (episode.actorId && !bot) throw new Error('Memory actor is unavailable.');
            if (bot && bot.workspaceId !== episode.workspaceId)
              throw new Error('Memory actor changed workspace.');
            const actor = bot || this.bots.list(episode.workspaceId)[0];
            if (!actor) throw new Error('A bot is required to resolve the memory model.');
            const config = this.providers.resolve(actor);
            const limits = contextLimits(config.contextWindow, config.maxOutputTokens);
            const compatible = config.provider.kind === 'compatible';
            const repairInstructions =
              '\nThe previous attempt did not produce a valid result. Return only a JSON object matching the required schema, including facts and reviewSummary. Include every required field; use null for unknown IDs/dates and [] for empty arrays. Do not include reasoning or markdown.';
            const system =
              extractionInstructions +
              '\nFor conversation reviews, use role, status, timestamps and completed tool evidence to distinguish human facts and verified outcomes from suggestions, plans, failures, and external payloads. Never treat scheduled prompts as human claims. Respect explicit human requests not to remember information. Include a concise reviewSummary explaining what is worth retaining or why nothing qualifies; do not include hidden reasoning.' +
              (compatible
                ? '\nRequired output JSON schema (include every required field, using null or empty arrays where appropriate):\n' +
                  JSON.stringify(await asSchema(memoryReviewOutputSchema).jsonSchema)
                : '');
            const instructionTokens =
              estimateTokens(system) + (compatible ? estimateTokens(repairInstructions) : 0);
            const data = {
              content: episode.content,
              referenceTime: episode.referenceTime,
              recentContext: episode.context,
              candidates: candidates.map((fact) => ({
                id: fact.id,
                subject: fact.subject,
                subjectId: fact.subjectId,
                relation: fact.relation,
                object: fact.object,
                objectId: fact.objectId,
                text: fact.text,
                validFrom: fact.validFrom,
                validTo: fact.validTo,
              })),
            };
            while (
              data.candidates.length &&
              estimateTokens(JSON.stringify(data)) + instructionTokens > limits.input
            )
              data.candidates.pop();
            if (estimateTokens(JSON.stringify(data)) + instructionTokens > limits.input) {
              data.recentContext = '';
              if (estimateTokens(JSON.stringify(data)) + instructionTokens > limits.input)
                throw new Error('Memory episode exceeds model context.');
            }
            // Bound the whole operation, while giving each repair a fresh request deadline.
            const operationSignal = AbortSignal.timeout(240000);
            let repair = '';
            let outputLimit = Math.min(limits.output, 12000);
            for (let attempt = 0; attempt < (compatible ? 2 : 1); attempt++) {
              const timeoutSignal = AbortSignal.timeout(120000);
              const abortSignal = AbortSignal.any([
                operationSignal,
                timeoutSignal,
                ...(signal ? [signal] : []),
              ]);
              let outputDetails: {
                finishReason?: string;
                generatedTextBytes?: number;
                outputTokens?: number;
                reasoningTokens?: number;
              } = {};
              try {
                const result = await generateText({
                  model: config.model,
                  output: Output.object({
                    schema: memoryReviewOutputSchema,
                  }),
                  system,
                  prompt: JSON.stringify(data) + repair,
                  abortSignal,
                  timeout: { totalMs: 120000 },
                  maxRetries: PROVIDER_MAX_RETRIES,
                  maxOutputTokens: config.provider.kind === 'chatgpt' ? undefined : outputLimit,
                  providerOptions: {
                    openai: {
                      store: false,
                      ...(config.provider.kind === 'chatgpt'
                        ? { systemMessageMode: 'developer' }
                        : {}),
                    },
                    anthropic: { thinking: { type: 'disabled' } },
                    google: { thinkingConfig: { includeThoughts: false } },
                  },
                });
                outputDetails = {
                  finishReason: result.finishReason,
                  generatedTextBytes: Buffer.byteLength(result.text),
                  outputTokens: result.usage.outputTokens,
                  reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
                };
                return result.output;
              } catch (error) {
                if (NoObjectGeneratedError.isInstance(error))
                  outputDetails = {
                    finishReason: error.finishReason,
                    generatedTextBytes:
                      error.text === undefined ? undefined : Buffer.byteLength(error.text),
                    outputTokens: error.usage?.outputTokens,
                    reasoningTokens: error.usage?.outputTokenDetails?.reasoningTokens,
                  };
                const retry =
                  compatible &&
                  attempt === 0 &&
                  !signal?.aborted &&
                  !operationSignal.aborted &&
                  (NoObjectGeneratedError.isInstance(error) ||
                    NoOutputGeneratedError.isInstance(error) ||
                    timeoutSignal.aborted);
                if (!signal?.aborted)
                  this.diagnostics?.record(
                    retry ? 'memory.extraction_retry' : 'memory.extraction_failed',
                    error,
                    {
                      providerId: config.provider.id,
                      providerKind: config.provider.kind,
                      model: config.modelId,
                      botId: actor.id,
                      conversationId: episode.conversationId || undefined,
                      messageId: episode.messageId || undefined,
                      phase: 'memory-extraction',
                      ...outputDetails,
                    },
                    retry ? 'warn' : 'error',
                  );
                if (!retry) throw error;
                // Regenerate from the evidence rather than treating the rejected output as facts.
                repair = repairInstructions;
                if (
                  outputDetails.finishReason === 'length' ||
                  NoOutputGeneratedError.isInstance(error)
                )
                  outputLimit = Math.min(limits.output, outputLimit * 2);
              }
            }
            throw new Error('Memory extraction attempts exhausted.');
          })
        )(request);
        this.reviews?.describe(
          request.episode.id,
          'reviewSummary' in result && typeof result.reviewSummary === 'string'
            ? result.reviewSummary
            : result.facts.length
              ? `Selected ${result.facts.length} durable facts: ` +
                result.facts.map((fact) => `${fact.disposition}: ${fact.text}`).join('\n')
              : 'No durable information needed saving.',
        );
        return result;
      },
      this.embedding,
    );
    this.reviews = new MemoryReviewService(
      this.store,
      this.engine,
      this.bots,
      (workspaceId) => this.settings(workspaceId).automaticCapture,
      reviewIdleMs,
      (scope, query) => this.searchScope(scope, query, { limit: 12 }),
    );
  }
  settings(workspaceId: string): MemorySettings {
    this.workspaces.require(workspaceId);
    const value = this.store.settingsValue(workspaceId);
    return value ? memorySettingsSchema.parse(JSON.parse(value)) : { ...defaults };
  }
  saveSettings(workspaceId: string, value: MemorySettings) {
    this.workspaces.require(workspaceId);
    const settings = memorySettingsSchema.parse(value);
    this.store.saveSettings(workspaceId, JSON.stringify(settings));
    if (settings.semanticSearch && !this.embedding.ready) void this.initializeModel(false);
    return settings;
  }
  scope(bot: Bot): MemoryScope {
    this.workspaces.require(bot.workspaceId);
    return {
      workspaceId: bot.workspaceId,
      // Historical bot-owned memories are shared too, without rewriting their provenance.
      includePrivate: true,
    };
  }
  private admin(workspaceId: string): MemoryScope {
    this.workspaces.require(workspaceId);
    return { workspaceId, includePrivate: true };
  }
  private async initializeModel(download: boolean) {
    if (this.modelTask) return this.modelTask;
    this.modelError = null;
    const task = (async () => {
      try {
        await this.embedding.initialize(download);
      } catch {
        this.modelError =
          'Local embeddings are unavailable. Download the model or check your connection and retry.';
      }
    })();
    this.modelTask = task;
    await task;
    if (this.modelTask === task) this.modelTask = undefined;
  }
  async setupEmbeddings(workspaceId: string) {
    this.admin(workspaceId);
    await this.initializeModel(true);
    if (!this.embedding.ready)
      throw new ApiError(503, this.modelError || 'Embedding setup failed.');
    this.saveSettings(workspaceId, { ...this.settings(workspaceId), semanticSearch: true });
    await this.engine.indexEmbeddings(this.admin(workspaceId), this.controller.signal);
    return { ready: true };
  }
  start() {
    this.reviews.recover();
    this.timer = setInterval(() => this.kick(), 3000);
    this.timer.unref();
    if (this.store.settingsValues().some((value) => JSON.parse(value).semanticSearch))
      void this.initializeModel(false);
    this.kick();
  }
  capture(bot: Bot, conversationId: string, messageId: string) {
    if (!this.settings(bot.workspaceId).automaticCapture || this.controller.signal.aborted) return;
    const message = this.messages.message(messageId);
    if (message.role !== 'user') return;
    this.reviews.schedule(bot.workspaceId, conversationId, bot.id);
    this.kick();
  }
  /* Explicit memory writes still use immediate extraction; automatic reviews batch messages. */
  private async drainReviews() {
    const updated = await this.reviews.drain(this.controller.signal);
    for (const workspaceId of updated) {
      if (this.embedding.ready && this.settings(workspaceId).semanticSearch) {
        try {
          await this.engine.indexEmbeddings(this.admin(workspaceId), this.controller.signal);
        } catch {
          this.modelError =
            'Some memories could not be embedded. Keyword search remains available.';
        }
      }
    }
  }
  private kick() {
    if (this.processing || this.controller.signal.aborted) return;
    const task = this.drain();
    this.processing = task;
    void task
      .catch(() => {})
      .finally(() => {
        if (this.processing === task) this.processing = undefined;
      });
  }
  private async drain() {
    await this.drainReviews();
    const allowed = this.workspaces
      .list()
      .filter((workspace) => this.settings(workspace.id).automaticCapture)
      .map((workspace) => workspace.id);
    const rows = this.store
      .all(
        `SELECT * FROM memory_episodes WHERE status='pending' AND source_key NOT LIKE 'review:%'
       AND (source_type!='user'${allowed.length ? ` OR workspace_id IN (${allowed.map(() => '?').join(',')})` : ''})
       ORDER BY created_at LIMIT 8`,
        ...allowed,
      )
      .map((row) => this.store.episode(row));
    for (const row of rows) {
      if (this.controller.signal.aborted) return;
      const workspaceId = row.workspaceId;
      if (!this.workspaces.list().some((workspace) => workspace.id === workspaceId)) continue;
      if (row.sourceType === 'user' && !this.settings(workspaceId).automaticCapture) continue;
      try {
        await this.engine.processEpisode(String(row.id), this.controller.signal);
      } catch {
        /* Persistent episode status contains a safe error; never log prompts. */
      }
      if (this.embedding.ready && this.settings(workspaceId).semanticSearch) {
        try {
          await this.engine.indexEmbeddings(this.admin(workspaceId), this.controller.signal);
        } catch {
          this.modelError =
            'Some memories could not be embedded. Keyword search remains available.';
        }
      }
    }
  }
  async add(
    bot: Bot,
    conversationId: string,
    messageId: string,
    content: string,
    sourceKey: string,
    signal: AbortSignal,
  ) {
    this.scope(bot);
    const input: EpisodeInput = {
      workspaceId: bot.workspaceId,
      ownerId: null,
      actorId: bot.id,
      sourceKey,
      sourceType: 'tool',
      content,
      referenceTime: new Date().toISOString(),
      conversationId,
      messageId,
    };
    return this.engine.addMemory(input, signal);
  }
  async search(bot: Bot, query: string, options: SearchOptions) {
    return this.searchScope(this.scope(bot), query, options);
  }
  private async searchScope(scope: MemoryScope, query: string, options: SearchOptions) {
    // Workspace opt-out applies even if another workspace initialized the shared model worker.
    if (!this.settings(scope.workspaceId).semanticSearch)
      return new MemoryEngine(this.store, async () => ({ facts: [] })).searchMemory(
        scope,
        query,
        options,
      );
    return this.engine.searchMemory(scope, query, options);
  }
  async recall(
    bot: Bot,
    conversationId: string,
    userId: string,
    assistantId: string,
    maxBytes: number,
  ) {
    const settings = this.settings(bot.workspaceId);
    if (!settings.automaticRecall) return '';
    const latest = this.messages.message(userId);
    const recent = this.messages
      .context(conversationId, 4, this.messages.sequence(userId))
      .filter((item) => item.role === 'user' && item.id !== userId)
      .map((item) => item.content.slice(-600));
    const query = redactCredentials(
      [latest.content.slice(0, 2000), ...recent.slice(-2)].join('\n'),
    );
    const scope = this.scope(bot);
    const engine = settings.semanticSearch
      ? this.engine
      : new MemoryEngine(this.store, async () => ({ facts: [] }));
    const context = await engine.getContext(
      scope,
      query,
      Math.min(maxBytes, settings.contextTokens * 3),
    );
    this.store.recordRecall(scope, {
      id: assistantId,
      conversationId,
      messageId: userId,
      createdAt: new Date().toISOString(),
      query,
      facts: context.hits.map((hit) => ({
        id: hit.fact.id,
        text: hit.fact.text,
        reasons: hit.reasons,
      })),
      characters: context.content.length,
    });
    return context.content;
  }
  snapshot(workspaceId: string, query = '', history = false): MemorySnapshot {
    const scope = this.admin(workspaceId);
    const all = this.store.facts(scope);
    const now = new Date().toISOString();
    const facts = all
      .filter(
        (fact) =>
          (history || (fact.validFrom <= now && (!fact.validTo || fact.validTo > now))) &&
          (!query ||
            `${fact.text} ${fact.subject} ${fact.object}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      )
      .slice(0, 200);
    const ids = new Set(facts.map((fact) => fact.id));
    const graph = this.engine.getGraph(scope, { includeHistory: history, limit: 300 });
    graph.edges = graph.edges.filter((edge) => ids.has(edge.id));
    const nodeIds = new Set(graph.edges.flatMap((edge) => [edge.subjectId, edge.objectId]));
    graph.nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
    return {
      settings: this.settings(workspaceId),
      facts,
      episodes: this.store.recentEpisodes(workspaceId),
      graph,
      recalls: this.store.recalls(scope),
      runs: this.reviews.list(workspaceId),
      totalFacts: all.length,
      embedding: {
        status: this.modelTask ? 'loading' : this.embedding.ready ? 'ready' : 'unavailable',
        model: this.embedding.model,
        error: this.modelError,
      },
    };
  }
  correct(
    workspaceId: string,
    id: string,
    input: { text: string; object: string; validFrom?: string },
  ) {
    return this.engine.correctMemory(this.admin(workspaceId), id, input);
  }
  forget(workspaceId: string, id: string) {
    this.engine.forgetMemory(this.admin(workspaceId), id);
  }
  forgetEpisode(workspaceId: string, id: string) {
    this.engine.forgetEpisodes(this.admin(workspaceId), [id]);
  }
  clear(workspaceId: string) {
    this.admin(workspaceId);
    this.store.run('DELETE FROM memory_review_runs WHERE workspace_id=?', workspaceId);
    this.store.run(
      'UPDATE memory_review_jobs SET checkpoint=COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id=memory_review_jobs.conversation_id),0),blocked=0 WHERE workspace_id=?',
      workspaceId,
    );
    this.engine.clear(this.admin(workspaceId));
  }
  retry(workspaceId: string, id: string) {
    this.admin(workspaceId);
    const run = this.store.get(
      "SELECT id FROM memory_review_runs WHERE workspace_id=? AND episode_id=? AND status='failed' ORDER BY started_at DESC LIMIT 1",
      workspaceId,
      id,
    );
    if (run) {
      this.retryRun(workspaceId, String(run.id));
      return;
    }
    this.store.retryEpisode(workspaceId, id);
    this.kick();
  }
  retryRun(workspaceId: string, id: string) {
    this.admin(workspaceId);
    this.reviews.retry(workspaceId, id);
    this.kick();
  }
  export(workspaceId: string) {
    return { version: 1, facts: this.store.facts(this.admin(workspaceId)) };
  }
  import(
    workspaceId: string,
    facts: {
      subject: string;
      relation: string;
      object: string;
      text: string;
      validFrom: string;
      validTo: string | null;
      state: 'confirmed' | 'uncertain';
      ownerId?: string | null;
    }[],
  ) {
    this.admin(workspaceId);
    if (
      facts.some(
        (fact) => fact.ownerId && this.bots.find(fact.ownerId)?.workspaceId !== workspaceId,
      )
    )
      throw new ApiError(
        400,
        'The original memory owner does not exist in this workspace. Import into the original workspace or remove ownerId from the import.',
      );
    return this.engine.importFacts(
      workspaceId,
      facts.map((fact) => ({ ...fact, ownerId: null })),
    );
  }
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.embedding.dispose();
    await Promise.allSettled(
      [this.processing, this.modelTask].filter((task): task is Promise<void> => Boolean(task)),
    );
  }
}
