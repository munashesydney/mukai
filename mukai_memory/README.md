# Mukai Memory

A separate TypeScript module inside the Mukai repository. It imports no Mukai code and does not run an HTTP server. The host supplies a SQLite connection, model callback, authorized scope, and lifecycle. Build with `npx tsc -p mukai_memory/tsconfig.json`.

## Implementation plan

1. Own SQLite schema and transactional temporal graph operations; source provenance and idempotent ingestion.
2. Structured extraction through a host callback; conservative entity resolution and explicit, validated supersession.
3. Hybrid keyword/CPU BGE retrieval with bounded graph expansion, historical queries, and budgeted context.
4. Mukai adapters: durable background capture, automatic recall per turn, tools, workspace settings, shutdown.
5. Memory inspector: list, focused graph, source evidence, history, corrections, forgetting, recall traces, import/export.
6. Validate temporal updates, backdated facts, coexistence, isolation, retries, deletion, retrieval, and packaged builds.

## Boundaries and behavior

- Workspace facts are shared; private facts belong to a bot and are never recalled in shared spaces. The host authorizes access; this module also scopes every query.
- `createdAt` is when a fact was recorded. `validFrom`/`validTo` describe event time, with an exclusive end. A mistaken claim is retracted with a zero-length interval and linked to its correction; it remains visible in audit history, not point-in-time recall. Unresolved conflicts are excluded from automatic recall.
- An explicit `asOf` always filters by validity, including when `includeHistory` is true. Use `includeHistory` without `asOf` for all recorded versions.
- Exact normalized names, explicit aliases, and authorized candidate entity IDs resolve identities. Extraction preserves name qualifiers and project codes; semantic similarity alone never merges people. Existing split entities are not silently merged.
- The model may nominate supersession only from supplied candidates, within the same owner, subject, and relationship. Different concurrent values can coexist. Explicit corrections use a transactional API.
- Persistent episodes track pending, processing, complete, failed, and forgotten states. A source key makes retries idempotent. Forgetting removes source content, derived facts, vectors, and recall traces; a source-key tombstone prevents replay from reintroducing it. Original Mukai chat history is managed by Mukai separately.
- BGE uses CLS pooling, normalized 384-dimensional vectors, and a retrieval query prefix. First setup downloads the quantized model to a host-supplied cache. Offline operation works once cached; keyword/graph retrieval remains available if embeddings are unavailable.
- Changing embedding configuration requires rebuilding vectors. The model/version is saved with each vector.
- Automatic capture processes user-authored statements, not assistant guesses, credentials, or complete document dumps. The configured LLM may be remote; local embeddings do not make model extraction local.
- Recognizable credentials are redacted before evidence storage/extraction; this is best-effort, not a secret-detection guarantee. Episodes with no extracted facts retain an idempotency marker but discard their raw content.
- Retrieval produces reference data, never system instructions. The host gives it a token budget, refreshes it per turn, and records the facts actually supplied.

## Public API

`MemoryEngine` exposes episode ingestion/processing, `addMemory`, `searchMemory`, `getContext`, `getGraph`, `correctMemory`, and `forgetMemory`. SQLite drivers, extraction models, and embeddings are supplied through interfaces. Settings and UI routes remain in Mukai.

## Limits

This is a focused temporal memory system, not a Graphiti compatibility implementation. Vector search currently scans scoped facts; graph expansion is bounded. Extraction/contradiction judgments are model-dependent. No claim of Graphiti benchmark parity is made. Database backup should include all memory tables along with Mukai's normal SQLite backup.

## Mukai setup and verification

Automatic capture and recall are on for new workspaces. Open **Settings → Memory → Download & enable** to install the quantized BGE model and build vectors. Without it, keyword and relationship retrieval work immediately. Failed extraction is visible under Capture activity and can be retried after fixing the model configuration. Memories are captured from new user messages; existing conversations are not backfilled automatically.

The inspector can search and visualize a bounded graph, inspect source evidence and relationship history, apply corrections, forget source-derived facts, and display the facts supplied for each reply. JSON export/import preserves fact validity intervals and private ownership; imports create new import provenance rather than restoring original chat links. Private imports require their owning bot to exist in the destination workspace.

From the repository root:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:memory-embeddings
npm run test:memory-ui
```

The last two checks exercise real BGE CPU inference (including cached offline operation) and the production renderer in a hidden disposable Electron window. Their model cache/screenshots live in ignored `artifacts/`. Root production builds include the module through relative imports; its own package manifest and build are ready for later extraction. The standalone server entry is now `dist/server/src/server/index.js` because the compiler includes both application and module sources.
