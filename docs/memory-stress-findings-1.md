# Mukai memory — stress test findings (session 1)

Target: dev instance `npm run dev` @ `http://127.0.0.1:47831` (browserMode, `/api` prefix),
workspace **test-workspace** `8a008086-8a7a-4e25-b949-21a7d87179b7`.
Memory: `enabled/automaticCapture/automaticRecall/semanticSearch = true`, embeddings ready
(`Xenova/bge-small-en-v1.5:q8:cls:normalized:v1`). Corpus markers namespaced `sx-*` for cleanup.

Harness: `/private/var/folders/d8/tdvgb3c15zj0dwfksrb80c_80000gn/T/opencode/mukai-stress/`
(`api.py`, `recon.py`, `suite1.py` inspector view, `suite2.py` round-trip/forget/isolation,
`suite3.py` forensics/latency, `suite4.py` end-to-end capture, `suite5.py` point-in-time matrix).

---

## A. Two writers, one store, different trust — tool-authored facts carry no evidence

Two paths write memory:

| path              | `sourceType` | content the extractor sees                                                 | trust                                 |
| ----------------- | ------------ | -------------------------------------------------------------------------- | ------------------------------------- |
| automatic review  | `user`       | role-tagged transcript JSON (`[{"role":"user",…},{"role":"assistant",…}]`) | has roles, timestamps, evidence array |
| bot’s memory tool | `tool`       | **free text the assistant composed**, `actorId = bot.id`                   | none — `memoryService.ts:600-612`     |

Observed from the tool path:

| stored fact                                                                                                                                                     | episode content (input to extraction)                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User — advises — Beta Labs`                                                                                                                                    | “The user has two ongoing external engagements: they consult for Acme Data, and they advise Beta Labs specifically on retrieval … (scope not otherwise specified) …” |
| `Tokyo site — uses_database_replication — PostgreSQL`, text “The Tokyo site uses PostgreSQL replication, **unaffected by the billing service storage change**.” | the assistant’s reply about the billing switch                                                                                                                       |

Nobody ever said “unaffected by the billing service storage change”: the assistant invented it in a
reply, wrote it through its own memory tool, and it is now a durable workspace fact that
`getContext()` feeds back into later turns with no author or evidence marker.
`README.md:24` (“Automatic capture processes user-authored statements, not assistant guesses”) holds
for the review path but is not enforced on the tool path.

**Correction of my first read:** the Acme/Beta and MEMTEST facts are not “capture reading the
assistant” — they are the assistant _writing_ memory itself. The automatic review path did behave:
it stored the user’s own dated statements (below).

## B. A superseded fact stays `confirmed` while the current fact is stored as `uncertain`

```
Billing Service | uses_database | PostgreSQL | 1970-01-01 → 2026-03-01 | state=confirmed
Billing Service | uses_database | SQLite     | 2026-03-01 → (open)     | state=uncertain
```

Human turn: “On 1 March 2026 we switched the billing service from PostgreSQL to SQLite.”

Consequence for automatic recall (`engine.searchMemory` default `includeUncertain: false`,
`mukai_memory/src/reconciliation/engine.ts:441`): the stale row is excluded by time, the current
row is excluded by state → **recall returns nothing about the billing database.** The workspace
knows the answer and cannot say it. Also `getContext()` (line 519) emits no `state` field, so even
when an uncertain fact is supplied the model can’t tell it was uncertain.

## C. Undated facts land on the epoch: `validFrom: 1970-01-01T00:00:00.000Z`

From “The billing service uses PostgreSQL for storage.” (no date stated). The instruction says
“Use referenceTime as the default validFrom” (`mukai_memory/src/extraction/schema.ts:26`); the
value that reached `commit()` was epoch zero. Every point-in-time query before 2026 now matches
that fact. Needs a clamp/reject of `validFrom` far from `referenceTime` (or a `null`-start
representation) rather than trusting the model’s date.

## D. DST offset error in resolved dates

“MEMTEST-02 Beacon rollout is owned by Dana Alvarez” (message stamped 2026-11-17T05:39:35Z =
2026-11-16 **21:39 −08:00** in `America/Vancouver`) stored `validFrom: 2026-11-16T07:00:00.000Z`,
i.e. midnight at **−07:00** (PDT). November 16 in Vancouver is −08:00. The prompt demands “Use the
timezone offset at the event date”; the offset used is the summer one. For date-only facts this is
harmless mid-day and flips the day for facts near midnight.

## E. Export → import of any workspace that ever had a correction fails atomically

```
POST /memory/import  (21 facts, one of them a retraction from GET /memory/export)
→ 500 {"error":"The server could not complete this request."}
→ facts landed in destination: 0
```

Export emits retracted facts as `validFrom == validTo` (`engine.correctMemory` →
`UPDATE memory_facts SET valid_to=valid_from`, `engine.ts:368`), while `commit()` rejects `to <= from`
(`engine.ts:254` throws a plain `Error`). The whole import is one transaction, so one retracted fact
poisons the entire restore. Contradicts `README.md:40` (“export/import preserves fact validity
intervals”). Removing only the retracted rows makes the same batch succeed.

## F. Two validation errors surface as HTTP 500 with no user-visible failure

```
validTo < validFrom        → 500 generic
validFrom == validTo       → 500 generic   (this is exactly the documented retraction shape)
```

`data/logs/errors.log`: `"event":"http.failed" … "message":"A memory end must follow its start."`
at `MemoryEngine.commit`. `GET /failures` stays `{"total":0,"items":[]}` → invisible in the UI.
Fix: reject with `ApiError(400, …)` at the route (engine throws `Error`, so the route layer needs
explicit interval validation).

## G. `ownerId` is validated then discarded on import

`memoryService.import()` rejects unknown owners, then maps `ownerId: null`
(`src/server/services/memoryService.ts:793`). Verified: imported fact has `ownerId: None`.
So private facts cannot be restored, yet the error message implies ownership is honoured — and
private/shared isolation is untestable through the API.

## H. Import reports work it did not do

Re-importing an identical batch returns `{"imported":1}` while `totalFacts` does not change
(dedupe by `sourceKey` hash is correct; the count is not). Same for episode-level replays.

## I. The inspector’s “memory” view is not retrieval

`MemoryService.snapshot()` filters with `text.includes(query)` and `.slice(0, 200)` with no ranking
(`memoryService.ts:692-701`); recall uses FTS5 bm25 + entity + vectors + a graph hop. Two different
answers to the same question, and the inspector has no `asOf` at all — you cannot see “what was true
on 2020-06-01” in the UI. Also `DELETE /memory/:id` takes a **fact** id while
`DELETE /memory/:id/episode` takes an **episode** id; both accepted `200 {"forgotten":true}` when I
passed a fact id to the episode route (id space collision).

## J. Recall noise: bare numbers outrank real facts

Recall traces (`GET /memory` → `recalls[].facts`), reason `keyword`, for the turn
“I lived in Lisbon until 31 August 2024, then moved to Toronto. / On 1 March 2026 …”:

```
{"text": "东京站点使用 PostgreSQL 复制。", reasons:["keyword"]}
{"text": "Bulk probe a number 31 about indexing throughput.", reasons:["keyword"]}
```

A 4-digit/2-digit token from an unrelated junk fact matched `31` and outranked everything
substantive. With 4 000 bulk facts loaded, numeric tokens act as a recall magnet. Suggest: drop
pure-numeric tokens from the FTS OR-expansion unless the whole query is numeric, or weight them
below text hits.

---

## What held up

- Temporal visibility rules in the inspector: expired / ended-yesterday / future-dated facts are
  hidden by default and visible with `history=true` (6/6 checks).
- `correct` with an explicit `validFrom` honours the supplied date; the retracted claim keeps an
  audit row with `supersededBy`.
- Forgetting: fact-level and episode-level deletes both remove derived rows, and a source-key
  tombstone blocks replay of identical content (2/2 checks).
- Field limits exact at boundary: subject 180 ok / 181 → 400, text 1200 ok / 1201 → 400,
  batch 1000 ok / 1001 → 400. NUL, newline, emoji and quote-injection round-trip intact.
- Workspace isolation: 11/11 other workspaces returned zero leakage for four distinct markers.
- Import throughput flat: ~150 ms per 1 000 facts at 1 k → 4 k corpus.

## Latency baseline (scratch corpus, semantic search off)

| corpus    | import 1000        | `GET /memory` | `GET /memory?q=` | `GET /memory/export` |
| --------- | ------------------ | ------------- | ---------------- | -------------------- |
| 1 k → 4 k | 168 / 151 / 148 ms | 221 ms @4 k   | 203 ms @4 k      | 157 ms, 4.3 MB @4 k  |

`snapshot()` and `store.rows()` both materialise the entire scope, so this is O(corpus) per request;
the unmeasured cliff is `searchMemory`’s JSON vector parse per row (384 floats × N per query) — that
is what `suite5.py` will measure next.

---

## Code changed in the working tree (needed for point-in-time testing)

1. `src/server/services/memoryService.ts`
   - new `scoped(scope, operation)` helper replacing the duplicated engine-selection branch, so
     search and context share the workspace `semanticSearch` opt-out;
   - `searchWorkspace(workspaceId, query, options)` → real `searchMemory` with
     `asOf` / `includeHistory` / `includeUncertain` / `limit`;
   - `contextWorkspace(workspaceId, query, maxBytes)` → the exact payload a turn receives;
   - `snapshot(..., asOf?)` — explicit `asOf` always filters by validity, matching `README.md:18`.
2. `src/server/http/routes.ts` — `GET /memory/search`, `GET /memory/context`, `asOf` on
   `GET /memory`.
3. `mukai_memory/src/reconciliation/engine.ts` — `getGraph(..., { asOf })` so the graph matches the
   point-in-time fact list.

`npx tsc --noEmit` clean. Needs a dev-server restart to load (main bundles the server:
`out/main/index.js`).

---

## Addendum — end-to-end chat run (`suite4.py`, `suite6.py`), 9 turns

Eight of nine turns produced durable facts, and precision was mostly right:

| user turn                                                              | result                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| “I lived in Lisbon until 31 August 2024, then moved to Toronto.”       | ✔ `resided_in Lisbon`, `resides_in Toronto`                                                                            |
| “I prefer dark mode and vim keybindings.”                              | ✔ two separate preference facts                                                                                        |
| “I consult for Acme Data and I also advise Beta Labs on retrieval.”    | ✔ kept as two facts, not merged                                                                                        |
| “MEMTEST-02 Beacon rollout is owned by Dana Alvarez.”                  | ✔ qualifier `MEMTEST-02 Beacon` preserved verbatim                                                                     |
| “On 1 March 2026 we switched … PostgreSQL to SQLite.”                  | ✔ old row closed at 2026-03-01 (but see B: new row `uncertain`)                                                        |
| “Maybe we should migrate the gateway to Rust next year.”               | ✔ correctly **not** stored                                                                                             |
| “My production API key is sk-prod-abcdef123456, do not remember that.” | ✔ correctly **not** stored, and **redaction verified**: no episode contains the literal key, one contains `[redacted]` |

Two earlier suspicions of mine were wrong and are retracted: the Lisbon/preference facts were not
dropped (reviews were still landing when I sampled), and the credential was not leaked.

### Remaining defects confirmed by the chat run

1. **Epoch stamping, third instance.** `User — resided_in — Lisbon | 1970-01-01 → 2024-09-01T07:00Z`.
   Undated openings keep becoming year-zero, so the workspace claims to know Lisbon held from 1970.
2. **DST is applied from the wrong season.** September 2024 → `2024-09-01T07:00Z` (= −07:00, correct).
   November 16 2026 → `2026-11-16T07:00Z` (= −07:00, **wrong**: Vancouver is −08:00 in November).
   A fixed summer offset is being used for winter dates; date-only facts shift an hour and can flip
   the day at `asOf` boundaries.
3. **Junk in memory changes answers, measurably.** After I loaded synthetic `sx-*` facts, asked
   “My launch was actually in June 2019, not March 2019”, the assistant answered “Your memory already
   says June — no new write was needed” and tabulated **my fabricated correction** as the real
   record. Recall also served `Sx private ownership probe.` and `Bulk probe a number 31 about
indexing throughput.` into live turns (reason `keyword`). Contamination is silent: nothing in the
   payload distinguishes a captured fact from an imported or invented one.

---

# Session 2 — stress lab (`lab.py`, `load.py`), 10 072-fact workspace

Workspace **Sx Stress Lab** `8131da32-8a66-4906-af3a-dd3da215f531`, memory + semanticSearch on,
`Xenova/bge-small-en-v1.5:q8:cls:normalized:v1`. `test-workspace` was restored to 0 facts
(`DELETE /memory`) before this phase.

## Corrections to session 1 — three of my claims were wrong

| claim                                                                     | truth                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “FTS indexes only `text`, so entity names and relations are unsearchable” | **Wrong.** `engine.ts:363` indexes `subject + relation + object + text`. Verified: `q="Sx Multiword Entity"`, `q="sx_operates"` (a relation), `q="MEMTEST-02"` all match. |
| “The 1-hop graph expansion silently caps at 24 facts”                     | **Wrong.** The `.slice(0, 24)` at `engine.ts:512` only limits rows _not already matched_; a query hitting 60 keyword matches surfaced all 60.                             |
| “Accent folding fails”                                                    | Only in the inspector. Recall matched `München` for `q="Munchen"` — FTS5 `unicode61` removes diacritics.                                                                  |

And the temporal core is **solid**: all 8 point-in-time probes correct, including the millisecond
exclusive-end boundary —

| `asOf`                     | expected active             | got                        |
| -------------------------- | --------------------------- | -------------------------- |
| `2021-06-30T06:59:59.999Z` | `sx-expired`, `sx-longspan` | ✔ exactly that             |
| `2021-06-30T07:00:00Z`     | `sx-longspan`               | ✔ (exclusive end honoured) |
| `2026-11-15T23:59:59.999Z` | + `sx-justended`            | ✔                          |
| `2026-11-16T00:00:00Z`     | − `sx-justended`            | ✔                          |
| `2029-12-31T23:59:59.999Z` | `sx-future` not yet         | ✔                          |
| `2030-01-01T00:00:00Z`     | `sx-future` starts          | ✔                          |

plus: uncertain excluded by default / includable on request; `history=true` includes expired but an
explicit `asOf` still filters (the documented rule); and after the patch the inspector and recall
agree on the fact set at the same instant.

## K. Imported facts are never embedded — restore silently loses semantic recall

10 072 imported facts, embeddings `ready`, and the semantic reason never fired:

```
BEFORE POST /memory/embeddings   hits=12  semantic=0     (at 1k, 3k, 6k and 10k)
POST /memory/embeddings          200 {"ready":true} in 17.8s
AFTER                            hits=12  semantic=6..12
```

`importFacts` (`engine.ts:613`) commits rows with `vector_json = NULL` and nothing backfills; the
semantic branch at `engine.ts:476-480` is skipped entirely when no row in scope carries a vector for
the active model. So any `export → import` restore (or bulk import) lands keyword-only, and the
user sees “semantic search: on” while it does nothing for those facts. Backfilling 10k facts costs
17.8s of CPU — cheap enough to run automatically after an import.

## L. Recall cost is O(corpus) per turn, and the vector scan is a 5× cliff

Latency vs corpus size, same server, 9 samples each (p50):

| corpus               | keyword query | semantic query | empty query | `GET /memory` | `export`         |
| -------------------- | ------------- | -------------- | ----------- | ------------- | ---------------- |
| 1 072                | 13.9 ms       | 18.5 ms        | 2.7 ms      | 51 ms         | 42 ms, 1.18 MB   |
| 3 072                | 29.6 ms       | 29.3 ms        | 6.9 ms      | 134 ms        | 88 ms, 3.39 MB   |
| 6 072                | 41.6 ms       | 52.0 ms        | 16.1 ms     | 305 ms        | 221 ms, 6.70 MB  |
| 10 072 (no vectors)  | 62.6 ms       | 80.4 ms        | 28.1 ms     | 544 ms        | 307 ms, 11.12 MB |
| **10 072 (vectors)** | **371 ms**    | **392 ms**     | **191 ms**  | **870 ms**    | —                |

The jump is `engine.ts:484-501`: every query JSON-parses the stored 384-float vector of **every**
row in scope and recomputes each row's norm, per request. Linear extrapolation puts a 50k-fact
workspace near ~2s per recall — and `recall()` runs inline before the model call, so it lands in
first-token latency. Fix shape: cache norms (or store vectors as blob/Float32 rather than JSON text),
and push the cosine scan into SQL or a maintained index instead of materialising all rows.

## M. Zero parallelism in the recall path

| workers | requests | p50    | p95    | throughput |
| ------- | -------- | ------ | ------ | ---------- |
| 1       | 6        | 63 ms  | 103 ms | 14.5 req/s |
| 4       | 24       | 248 ms | 261 ms | 16.0 req/s |
| 8       | 48       | 509 ms | 547 ms | 15.5 req/s |

Throughput is flat while latency grows linearly: the work is single-threaded JS on the main process
(RSS ~1.05 GB, ~102 % CPU throughout). Concurrent chats' recall queue behind each other, so N active
conversations multiply each user's wait. Note this is _without_ vectors; with them, 8 concurrent
recalls on 10k facts are ~2.5 s each.

## N. Non-Latin content is unreachable by both retrieval paths

`q="东京"`, `q="东京站点"` → 0 hits, and after backfill `q="which site runs database replication"` → 0
semantic hits, for the fact “东京站点使用 PostgreSQL 复制协议。”. Neither side segments CJK: FTS5
`unicode61` indexes the run as one token (`东京站点使用`), the JS tokenizer
(`engine.ts:24`, `[\p{L}\p{N}_-]{2,}`) produces `东京站点`, and an English-only `bge-small-en` won't
bridge it either. Any workspace with CJK notes is effectively keyword-only for exact whole-run
matches.

## O. The private/owner abstraction is dead code (confirmed against your live DB)

You said memory is workspace-wide, not per bot — the data agrees: **6 571 facts, all `owner_id =
NULL`; 6 322 entities, all `owner_key = ''`; 0 names duplicated across owner keys.** Yet the code
still carries `MemoryScope.includePrivate`/`privateOwner` SQL (`sqlite.ts:78-86`), the per-owner
entity uniqueness, the import `ownerId` pre-check that then nulls it, and
`README.md:16`/`:40` still promise “private facts belong to a bot and are never recalled in shared
spaces”. Nothing enforces or tests any of that — it should be deleted or documented as reserved, and
`README.md:16` corrected, because today it invites exactly the wrong mental model.

## P. Mutations are correct; the API's error hygiene is not

Corrections and supersession chains held up under everything I threw at them:

| scenario                                                    | result                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| correct an already-expired fact (explicit past `validFrom`) | ✔ new row `2018-06-01 → open`, old row collapsed to a zero-length retraction with `supersededBy`                     |
| correct a fact twice (depth-2 chain)                        | ✔ `target → c1 → c2 → c3`, every link carries `supersededBy`, current view shows exactly one current row per lineage |
| self-correction re-stating the same object                  | ✔ older row retracted; two rows share the object name, which reads as a duplicate in the inspector (cosmetic)        |
| mixed batch with one over-length row                        | ✔ `400`, `totalFacts` unchanged — whole batch rejected                                                               |
| 4 parallel identical imports of 200 facts                   | ✔ exactly 200 rows added, all `200`, 0.06 s — `sourceKey` idempotency survives the race                              |

What fails is how failures are reported:

| call                                                                | got                                                  | should be                        |
| ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| `POST /memory/:id/correct` with a **different workspace's** fact id | `500` generic                                        | `404`                            |
| `DELETE /memory/:id` with a foreign fact id                         | `500` generic                                        | `404`                            |
| `DELETE /memory/:id/episode` given a **fact** id                    | `200 {"forgotten":true}` while nothing was forgotten | `404`, and a distinct path param |
| `POST /memory/<random-uuid>/retry`                                  | `200 {"queued":true}`                                | `404`                            |
| 4× identical import                                                 | each `{"imported":200}` for 200 rows total           | honest per-request count         |
| re-import after forgetting                                          | `200` and no rows                                    | say `deduped`/`replayed`         |

Isolation itself is **sound**: no intruder row appeared in `test-workspace`, and the stress-lab fact
survived every cross-workspace correct/forget/forget-episode attempt. A 500 with a generic message is
the right _outcome_ communicated the wrong way — it is indistinguishable from a server fault, and the
`200 {"forgotten":true}` and `200 {"queued":true}` cases are worse: they tell the caller work happened
when none did. (I initially read the chain test as broken — that was my own stale snapshot; the
re-check above is the accurate result.)

## Q. Recall contends with writes

One observation, single sample: a `search` issued _during_ a 1 000-fact import took **571 ms** versus
the 371 ms vector-scanned baseline (+54 %). Same single-threaded cause as L and M: capture, imports
and recall share one event loop, so a bulk restore makes every concurrent conversation's recall
slower. Worth repeating on an idle machine before treating the number as load-bearing.

---

## Punch list, ordered by what a user feels first

1. **`uncertain` hides the newest truth from recall** (B). A switch that the extractor marks
   uncertain deletes the old fact by time and hides the new one by state: the answer becomes
   “unknown”. Either let `replace`/`correct` outcomes stay recallable and label them, or fall back to
   the uncertain row when nothing confirmed matches — never silently return nothing.
2. **Tool-authored facts need the same evidence rule as capture** (A). Require `addMemory` calls to
   cite a message id, or store the author kind on the fact, and surface `state`/author in the
   `getContext` payload (H) so the model can discount guesses and uncertain items.
3. **`validFrom` must not be trusted raw** (C). Reject or re-clamp to `referenceTime` when the model
   supplies a year-zero-ish or wildly early start for a fact with no stated beginning; introduce an
   explicit “start unknown” representation instead of 1970.
4. **Offset per event date, not per season** (D). Derive the offset from the workspace timezone _at
   the event date_; the current output uses the summer offset for winter dates.
5. **Backfill vectors after import/restore** (K). Run the 17.8s-per-10k `indexEmbeddings` at the end
   of `importFacts` (or in the background per import), otherwise restored memory is keyword-only
   while the UI says semantic search is on.
6. **Make `correct`/retraction round-trippable, and validate intervals at the route** (E, F). Export
   emits `validTo == validFrom`; import rejects it, atomically losing the restore. Accept the
   retraction shape on import, and turn both interval errors into `400` with a specific message that
   reaches `GET /failures`.
7. **Cache cosine norms / stop materialising the scope per query** (L, M, Q). ~65 ms → ~371 ms at
   10k facts once vectors exist, ~15 req/s ceiling with zero parallelism, and it is paid inline before
   every reply.
8. **Retrieve non-Latin content** (N). CJK currently fails keyword _and_ semantic recall.
9. **API honesty pass** (P). `404` for foreign/unknown ids instead of `500`; no `200 {"forgotten":
true}` / `{"queued":true}` when nothing happened; honest `imported` counts; separate path params
   for fact ids and episode ids.
10. **Delete or document the private/owner path** (O), and fix `README.md:16`/`:40` to say memory is
    workspace-wide.

Solid and worth keeping as-is: the temporal core (exclusive ends, `asOf`, history), uncertainty
handling as a _flag_, forgetting with tombstones, entity-name uniqueness (0 duplicate names across
6 322 entities), batch limits and field-length boundaries, credential redaction, workspace isolation,
and idempotent concurrent imports.

---

# Session 3 — fixes applied (uncommitted, needs a live re-run to confirm)

Every fix below has a regression test in `src/server/memory.test.ts`; `npx vitest run` is green
(177 files / 1745 tests before these tests, 30 in the memory file after).

| #   | defect                                                           | fix                                                                                                                                                                                                                                                                                                                                                                                                                                         | where                                                                                                        |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | uncertain record hid the newest truth                            | recall is now **tiered**: confirmed records first; if nothing matches, the uncertain records in the same scope answer instead, marked as such. Never silently empty.                                                                                                                                                                                                                                                                        | `mukai_memory/src/reconciliation/engine.ts:470-482`                                                          |
| 2   | assistant-authored facts indistinguishable                       | `getContext` emits `state` plus `evidence` (the source kinds: `user`, `tool`, `import`, `correction`, `review`) per record, and the chat preamble tells the model that `state:"uncertain"` or tool/assistant-only evidence is a lead to hedge, not a fact. The memory tool description now says writes are stored as assistant-authored.                                                                                                    | `engine.ts:578-590`, `src/server/services/chatService.ts:1534-1541`, `src/server/tools/memory/definition.ts` |
| 3   | undated facts stamped 1970                                       | `commit()` treats the epoch day and year-zero as _placeholders for “no stated beginning”_ and re-anchors them to the episode's `referenceTime`. A genuine historical date keeps its month/day and is untouched (`1968-05-04` survives, `1970-01-01T00:00:00Z` does not). Imports pass `trustedIntervals` so a backup is restored byte-faithful.                                                                                             | `engine.ts:24-30`, `254-266`                                                                                 |
| 4   | winter dates stored at the summer offset                         | extraction prompt now states the rule explicitly: `referenceClock.offset` applies to `referenceTime` only; use the offset in effect **on the event date**, and `00:00` at that date's own offset when no time is stated. Prompt-level only — a real fix needs the offset computed from the workspace zone per candidate date, which needs a representation decision.                                                                        | `src/server/services/memoryService.ts:236`                                                                   |
| 5   | imports never embedded, so restore silently lost semantic recall | background pass embeds what is missing: `engine.pendingEmbeddings()` (one `COUNT(*)`) gates a bounded 1 024-row `indexEmbeddings` per drain cycle, so a 10k restore catches up in ~18 s of CPU without blocking capture or recall; `import` also kicks the queue. Vector cache is invalidated on write and on forget.                                                                                                                       | `memoryService.ts:596-620`, `engine.ts:446`, `engine.ts:407-412`                                             |
| 6   | export → import 500'd after the first correction                 | `commit()` accepts `validTo == validFrom` as the retraction shape export produces; the route pre-validates the whole batch (`validTo` strictly after `validFrom`, equal allowed) and returns `400 Memory N ends before it begins…` instead of a generic 500 that rolled back the restore.                                                                                                                                                   | `engine.ts:264-266`, `src/server/http/routes.ts:555-566`                                                     |
| 8   | dishonest API responses                                          | `correct`/`forget`/`forget-episode`/`retry` now `404` for unknown or foreign-workspace ids (`409` when a source exists but never failed) instead of a generic 500; `DELETE` returns `{forgotten:true, sourcesRemoved:n}`; `retry` distinguishes `{queued}` from `{unblocked}`; `POST /memory/import` returns `{imported, deduplicated, forgotten}` counted from the real episode state; the memory tool's `forget` returns the same counts. | `memoryService.ts:763-830`, `routes.ts:576-596`, `tools/memory/execute.ts:59-67`                             |
| 9   | recall cost                                                      | parsed vectors **and their norms are cached** per fact id (`SQLiteMemoryStore.vector()`), so a query no longer JSON-parses 384 floats × corpus on every turn; cosine now requires equal vector length.                                                                                                                                                                                                                                      | `mukai_memory/src/storage/sqlite.ts:131-160`                                                                 |
| 10  | misleading private-memory docs                                   | `mukai_memory/README.md:16` and `:40` and `README.md:52` now say memory is workspace-wide, that the optional owner scope is unused by the host, and what an import actually reports. The `ownerId` pre-check message no longer implies ownership is restored.                                                                                                                                                                               | READMEs, `memoryService.ts:851-856`                                                                          |

Also fixed while in there: `store.facts()` loaded sources with **one query per fact**, which is what
made `GET /memory` take 870 ms at 10k facts; it now chunks the source join for the whole page.

### New tests (`src/server/memory.test.ts`)

`answers missing and foreign memory ids with 404, never a server fault` ·
`reports what an import changed and refuses intervals that end before they start` ·
`round-trips corrected history through export and import` ·
`recalls the only uncertain record instead of nothing and marks it unverified` ·
`treats an epoch validFrom as no stated beginning and keeps a real historical date` ·
`embeds imported facts in the background so restored memory stays semantic`

### Deliberately not done

- **Non-Latin retrieval (N)**. CJK still fails keyword and semantic recall: FTS5 `unicode61` indexes
  an unsegmented run and `bge-small-en` cannot bridge it. Fixing it means either a CJK tokenizer plus
  a multilingual embedder, or accepting it. Your call.
- **The remaining recall cost** (L, M, Q). Norm caching removes the dominant per-query work, but recall
  still materialises every row in scope and scans them in single-threaded JS, so it stays linear in
  workspace size and one recall still queues behind another. The real fix is pushing the cosine scan
  into SQL or a maintained index, and that deserves its own change.
- **The one-hour offset bug** is nudged, not repaired (see row 4).

Re-run after restart: `lab.py` (point-in-time matrix and the uncertain tier), `mutate.py` (404s and
honest counts), `suite2.py` (retraction round-trip), then a fresh `load.py` to see where the latency
line moved.

---

# Session 4 — re-test on the restarted server

## What the fixes did live

Measured on `Sx Stress Lab` with **11 278 facts, all vectorised** (the session-2 baseline was 10 072
facts, so this corpus is 12 % larger):

| path                                     | session 2 | now            |                             |
| ---------------------------------------- | --------- | -------------- | --------------------------- |
| `GET /memory/search` keyword             | 371 ms    | **280 ms** p50 | −25 % on a bigger corpus    |
| `GET /memory/search` semantic paraphrase | 392 ms    | **265 ms** p50 | −32 %                       |
| `GET /memory` (inspector)                | 870 ms    | **481 ms** p50 | −45 % (batched source join) |
| `GET /memory/export`                     | 307 ms    | 310 ms         | unchanged                   |

Behaviour, all against the restarted server:

| check                                                                      | result                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unknown / foreign-workspace `correct`, `forget`, `forget-episode`, `retry` | `404` with a specific message (was `500`), and the foreign row survives every attempt                                                                               |
| `DELETE /memory/:factId/episode`                                           | `404` (a fact id is not an episode id)                                                                                                                              |
| `DELETE /memory/:factId`                                                   | `{"forgotten":true,"sourcesRemoved":1}`                                                                                                                             |
| import × 2 identical                                                       | `{imported:20,deduplicated:0,…}` then `{imported:0,deduplicated:20,…}`                                                                                              |
| `validTo < validFrom`                                                      | `400 Memory 1 ends before it begins. An end equal to its start is allowed as a retraction.`                                                                         |
| export → import into a fresh workspace after a correction                  | `200`, all rows, retraction stays historical (2 current of 3), second import reports `deduplicated`                                                                 |
| only record is uncertain                                                   | recall returns it, hedged; payload line carries `"state":"uncertain"","evidence":["import"]`; a later confirmed record outranks it; `?uncertain=true` still opts in |
| imported facts + `semanticSearch` on, no manual embeddings call            | 200 facts embedded within **5 s**, paraphrase recall 12/12 hits carry the `semantic` reason                                                                         |
| numeric junk (`31`) vs substance                                           | substance now ranks first                                                                                                                                           |
| `31 August` query                                                          | `kestrel-31-aug` above `Bulk probe a number 31`                                                                                                                     |

11/11 corrected checks passed (`verify2.py`), plus the earlier 12 (two of my first-pass failures were
my harness: a folder that didn't exist, and a query term that matched my own junk records).

## R. A restore after a forget silently wrote nothing — the dishonest count had been hiding it

`lab.py` seeds 72 facts by import. After `DELETE /memory` (Clear all) it now reported:

```
import: 200 {'imported': 0, 'deduplicated': 0, 'forgotten': 72}     totalFacts: 0
```

`clear()` tombstones every episode as `forgotten`, and `importFacts` skipped any episode that already
existed with that status — so **after you forget a fact, or clear a workspace, the same JSON could
never be imported again**. That is pre-existing (the same branch existed before my change); what
changed is that the route used to answer `{"imported":72}` while writing nothing, so it looked like it
worked. Fix: an import re-arms its own `import:` source instead of skipping it, because a forget has to
block _automatic replay_ but must not veto a deliberate restore. Chat and review sources are untouched,
so a forgotten message still cannot come back on its own. The count is now
`{imported, deduplicated, revived}`, and `revived` is what a restore after a forget reports.

Trade-off I chose, stated so you can overrule it: if you forget a fact and later import a backup that
contains it, the import wins (and says `revived: 1`). Mukai cannot tell "old backup" from "I changed my
mind", and silently dropping rows of a file the user just picked is the worse failure.

Also in this pass: recall stopped reading `vector_json` with every row (`store.rows()` is now the fact
columns only) and reads vectors through `vectorsIn()`, which fetches the id list per query and hydrates
values from the cache, so a query no longer drags ~4 KB of vector text per fact into JS.
`indexEmbeddings` uses the matching `pendingVectors()` query instead of filtering the whole corpus in JS.

---

# Session 5 — read-only audit of the real corpus: is a maintenance pass warranted?

Prompt from the user: should Mukai run an automated pass over stored memories and remove stale ones —
and no, a human review queue is not acceptable ("we don't want the human being directly in this memory
loop"). Before designing anything, measure.

Method: SQLite opened `mode=ro`, no writes, no HTTP mutations (`audit.py` … `audit8.py`). Scope: the six
real workspaces — **2 518 facts** (largest `aitc` 1 247), 2 306 of them current, 1 778 current and not
superseded, i.e. what recall can actually serve today.

## Verdict: no janitor. Two write-path bugs instead, both measured.

### 1. Nothing is stale in a way that would justify a delete

| measure                                                         | result |
| --------------------------------------------------------------- | ------ |
| `valid_from` before 1990, or epoch placeholders, in stored rows | 0      |
| `valid_to` earlier than its own `valid_from`                    | 0      |
| rows missing from the FTS index / orphan FTS rows               | 0 / 0  |
| hard deletes a maintenance pass could justify                   | 0      |

212 of 2 518 facts are historical and still answer `asOf` probes correctly. That is the graph doing its
job — staleness is already a query-time property (`valid_to` + `superseded_by`), not a row to remove.

### 2. `uncertain` is a young backlog, not a rotting one

201 rows (91 `aitc`, 55 `pointerful`, 47 `telegramrelay`; 7–9 % of facts in busy workspaces), **all under
30 days old, none superseded**. Reading them, they are hedged-but-useful records — "Verified on
2026-11-1…", "commit 69a5c2e was pushed to main…" — not noise. Auto-retiring them would delete recall
the user wants. No action.

### 3. "The bot invented it" is mostly not happening

1 168 served facts carry only `tool` provenance. Of those, **1 097 (94 %) were written in a turn with
completed tool activity**: the bot recorded something it verified rather than something a human said.
Only **71** have no tool activity in their turn, and they read as defensible inferences — e.g.
"Nothing bro - ur just gonna be my bro…" → _prefers a casual, friendly "bro" tone_.

My earlier "69.7 % weakly supported" figure was **measurement error**: it compared each fact with the
immediately preceding human message, which in an agent transcript is often "Continue".

### 4. Duplication is real, small, and caused by a bug rather than by volume

| measure                                                    | count                                            | honest read                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| same sentence current, unsuperseded, served more than once | **37 excess rows / 1 778 (2.1 %)**, in 34 groups | the only defensible duplicate count                                                                                                                                                 |
| same subject+relation+object with different wording        | 120 groups / 260 rows                            | mixed — some one claim re-worded in the same session, others genuinely different events (`has_updated_section` §7: renumbered, rewritten, then "updated to list twelve test cases") |
| wording-overlap ≥ 0.6 clusters                             | ~10 %                                            | **retracted as junk signal** — it groups "Coolify hosts free-copier-next" with "Coolify hosts free-copier-py", and ticket 608 with ticket 609. Different claims that read alike.    |

Why identical sentences get written twice — `audit7.py` replays `commit()`'s guard against the stored
rows (34 groups, 71 served copies; **all identical after `normalize()`**, so the text test passed):

| predicate that let the pair through                                                                      | pairs |
| -------------------------------------------------------------------------------------------------------- | ----- |
| existing row starts _later_ than the new claim — the guard is one-directional (`row.valid_from <= from`) | 19    |
| `state` differs: same sentence stored once `uncertain`, once `confirmed`, **both served**                | 6     |
| guard should have matched and did not                                                                    | 13    |

The 13 are the important ones. `commit()` skips the duplicate check entirely when the write's
disposition is `replace`/`correct` (engine.ts:308), then supersedes only the ids the model listed in
`supersedes` — and only ids present in the **60** related candidates handed to the model
(engine.ts:138). A replace whose target falls outside that window inserts a second row, and per
engine.ts:344 a replace with no valid target is stored as `uncertain`. So **corrections get less
reliable as a workspace grows**, and they can silently demote themselves to uncertain. That is the
scale-linked defect; the fix is at write time, not in a janitor.

Duplicate pairs are written 1–15 minutes apart, usually through two channels: the bot's own `memory`
tool (`tool`) and the automatic review of the user's message (`user`). Same claim, two provenances, two
rows — while the branch at engine.ts:308 already knows how to attach a second source to one row.

### 5. The real defect: capture failures are terminal

- **38 failed episodes** — `aitc` 18, `pointerful` 13, `telegramrelay` 9 — of which **36 were attempted
  exactly once** and have sat 3–19 days with `Memory extraction failed. Check the configured model and
retry.` They wrote zero facts.
- **18 failed review runs** whose messages were never read again (10 others were later covered).
- **2 review-sourced episodes stuck `pending`** (since 11-06 and 11-11): `drain()` filters
  `source_key NOT LIKE 'review:%'` and the review layer no longer owns them, so nothing will process
  them.
- Every source message still exists, so a retry has something to read. `POST /memory/:id/retry` exists
  and works — nothing calls it automatically. `start()` only re-queues `processing` rows (sqlite.ts:55).

This is the one place where memory is quietly **missing** rather than merely untidy, so it is worth more
than any tidy-up: those turns contributed nothing to recall, and a maintenance pass over stored facts
would never notice.

## What to build instead, in this order

1. **Retry capture.** On the existing 3 s tick, re-queue `failed` episodes with backoff and a cap on
   `attempts`, plus orphaned `review:%` pending episodes; after N attempts leave them visible in the
   inspector. No model, no judgement, recovers lost memory. Re-run failed review runs the same way.
2. **Symmetric duplicate guard.** Match on _overlapping_ intervals instead of "existing starts first";
   route a second identical claim through the existing source-attach branch instead of inserting a row;
   decide the `uncertain` vs `confirmed` pair deliberately rather than serving both.
3. **Let corrections find their target.** For `replace`/`correct`, resolve candidates from the DB by
   (subject, relation) instead of relying on the 60 rows shown to the model, and stop storing a
   replace-with-no-target as `uncertain`.
4. **Only then**, if still wanted, a reversible merge pass over what remains — 37 rows today. The audit
   strengthens the earlier constraint rather than weakening it: a `replace` that cannot see its target
   already creates duplicates, so a model asked to "tidy" 10 k rows would be doing exactly that at
   scale, with its own provenance attached.

Not doing: a human approval queue (rejected — the human holds the veto and reads the trail, but is not
in the loop); deleting for staleness (would destroy the point-in-time property that survived every
probe in sessions 1–4).

---

# Session 6 — built the two write-path fixes from the audit

No janitor. What the audit said was actually wrong is now wrong no longer, at the write path.

## 1. Capture failures retry instead of discarding the exchange

`mukai_memory` schema version 2: `memory_episodes.retry_at` (`storage/sqlite.ts` adds it with a
guarded `ALTER`, so an existing database upgrades on launch; existing NULL rows are eligible, which is
what recovers the 38 failures the audit found).

- `engine.process()` stamps `retry_at` on a bounded backoff — 1 min, 5 min, 30 min — and leaves it
  `NULL` once `CAPTURE_ATTEMPT_LIMIT` (four attempts) is spent. Aborts still go straight back to
  `pending`, and success clears the schedule (`reconciliation/engine.ts`).
- `MemoryService.drain()` runs `retryFailures()` after the fresh-episode pass: eligible failures only,
  four per pass, oldest schedule first, so a backlog of old failures cannot starve new capture
  (`services/memoryService.ts`). Review-sourced episodes are excluded because the review queue owns
  their run records.
- The review queue no longer blocks a conversation on the first failure. It schedules `due_at` on the
  same ladder and only sets `blocked=1` after the fourth, so a model that was restarting gets another
  go and a genuinely broken one still waits for the user in Settings
  (`services/memoryReviewService.ts`).
- A review that re-reads a stretch of chat closes the abandoned attempts for that conversation instead
  of leaving them `pending` forever — this is what the audit's two stuck episodes were: `drain()` skips
  `review:%` and the review layer had moved on.

## 2. One claim, one row — and corrections reach their target

`commit()` (engine.ts) changed in three places:

| before                                                                                                                                                                                                | now                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the stored row had to start **no later** than the new claim, so an identical sentence whose second copy stated an earlier beginning was written twice                                                 | the intervals only have to **overlap**; the merge keeps the earlier start                                                                                                                                      |
| identical wording stored once `uncertain` and once `confirmed` was **served twice**                                                                                                                   | one row: attach the new source, a plain statement settles the hedge, a later hedge never demotes a confirmed record                                                                                            |
| a `replace`/`correct` skipped the duplicate check and superseded only ids inside the **60** candidates handed to the model, so an unseen target left a second copy of the claim hedged as `uncertain` | ids are resolved from storage (still scoped to workspace, owner, subject and relationship, still refusing an already-superseded target), and a replacement that resolves nothing merges instead of duplicating |

Deliberately unchanged: a row with an end date and an open row of the same sentence stay two rows, and
`replace` with no resolvable target is still stored hedged. Both are history and honesty, not
duplicates — the point-in-time behaviour is what survived every probe in sessions 1–4.

## Verified

`src/server/memory.test.ts` is now 40 tests; 9 new, and each was re-run against the old code to
confirm it bites:

| test                                                                          | fails on the old code as                      |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| merges a claim re-learned through another channel                             | 2 rows instead of 1                           |
| keeps one row when the same sentence arrives hedged and plain                 | 2 rows instead of 1                           |
| does not duplicate a claim when a replacement cannot see its target           | duplicate + hedge                             |
| replaces a fact the model names even when it was outside the candidate window | `expected 'uncertain' to be 'confirmed'`      |
| retries a capture the model dropped instead of losing the exchange            | episode stayed `failed`, no fact ever written |
| stops retrying a capture once the bounded attempts run out                    | (new behaviour, no prior state)               |
| retries a failed review on a backoff instead of blocking the conversation     | job `blocked=1` on the first failure          |
| blocks a conversation whose reviews keep failing                              | (new cap; asserts the user can still retry)   |
| closes a review attempt that a later review already covers                    | orphan stayed `pending`                       |

`npm run typecheck` clean, ESLint clean, Prettier clean, full suite green.

## What this buys the live database

Baseline taken before shipping (`capture_health.py`, read-only): **40 failed episodes** (aitc 18,
pointerful 12, telegramrelay 8, test-workspace 2; the audit pass a little earlier read 38), **18 failed
review runs** whose messages were never re-read, **17 conversations with a blocked review job** (aitc
10, pointerful 5, telegramrelay 2), and 2 review-sourced episodes stuck `pending`. 37–38 rows of served
memory were literal duplicates.

The migration was rehearsed against a **copy** of the live database before shipping: schema version
1 → 2, `retry_at` added, all 17 672 episode rows preserved, `PRAGMA integrity_check` ok, and 40 failed
episodes matching the retry conditions.

That 40 was overstated, and the correction matters: the rehearsal query left out the `review:%`
exclusion, so it counted episodes the review queue owns. The retry pass itself is right — of those 40,
17 were captures it could take back and the rest were review attempts that only the review queue may
re-run. Existing duplicates are left alone: nothing in this change rewrites or deletes a user's memory.
The 38 already-stored redundant rows are the first thing a one-off merge would clean up, if you want it
— that is a separate, explicit operation, not part of this fix.

## Live, after restart (schema v2 in production)

| check                               | result                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| migration on the real database      | version 2, `retry_at` present, episode rows per workspace identical to the pre-restart baseline (aitc 475, pointerful 191, telegramrelay 159 — only statuses moved), `integrity_check` ok, FTS drift 0                                                                                                                                                                                                         |
| restore-after-forget (`verify4.py`) | **10/10**, including `{imported: 0, deduplicated: 0, revived: 2}` after a clear-all and `{revived: 1}` after forgetting one fact                                                                                                                                                                                                                                                                               |
| point-in-time (`lab2.py`)           | **27/27**: 11 instants × (recall + inspector) agree exactly with the seeded spans, ends exclusive to the millisecond, `history=true` keeps all five spans answerable, an ended claim answers only for its own era, a future claim is never served early                                                                                                                                                        |
| capture retry                       | failures went **40 → 22: 17 dropped exchanges recovered** on a later attempt and one abandoned review attempt closed, with **+50 facts** (aitc 21, telegramrelay 21, pointerful 6). Of the 22 still failing, **21 are review-sourced episodes** that only the review queue may re-run (they belong to 15 blocked conversations), leaving **1** capture in the ladder on its 30-minute rung and **0 abandoned** |
| duplicate guard                     | 38 redundant rows before and after, and **0 duplicate groups contain a row written after the restart** — the guard holds in production. The 37 → 38 drift was a pair the old build wrote seven hours before it                                                                                                                                                                                                 |
| cleanup                             | the four scratch workspaces (4 077 synthetic facts) deleted through the name-confirmation route; 0 orphan facts, episodes, entities, FTS rows or recall traces for those ids; every real workspace unchanged                                                                                                                                                                                                   |

Two notes for whoever reads this next. `lab.py`'s point-in-time expectations were wrong, not the
engine: its `limit=200` is above the API's cap of 100, so every probe got a 400 that read as "nothing
served", and its expected sets were hand-typed instead of derived from the seeded spans. `lab2.py`
derives them. And a review job whose checkpoint already covers the conversation keeps a stale `due_at`
forever, so "waiting > 1 d" counts of 135 were never a backlog: measured properly, **262 of 279 review
jobs have nothing new to read and 0 are actionable** — the only conversations with unread messages are
the 17 blocked ones. (An intermediate reading of "124 blocked jobs" was a `LEFT JOIN messages`
multiplying `COUNT(*)`; the real number is 17.)

One deliberate rough edge: the review ladder counts failures since the last successful run, including
failures recorded before this build existed, so a conversation with three old failures gets one more
attempt rather than four. Total attempts per conversation stay bounded either way, which is what the
cap is for.

---

# Session 7 — the one-off fold, as an operation rather than a script

The audit found rows the old write path had already stored twice. The guard stops new ones, so
"fix the current ones" needs a maintenance operation, not a throwaway script — it gets an endpoint, an
offline entry point, and tests, and it stays.

## What it does

`MemoryEngine.consolidateClaims(scope, apply = false, limit = 100)` (`reconciliation/engine.ts`),
`MemoryService.consolidate()`, `POST /api/memory/consolidate` with `{ apply?, limit? }`, and
`npx tsx scripts/consolidate-memory.ts <database> [report|apply]` for a stopped server.

It groups **served** rows only — `valid_to IS NULL AND superseded_by IS NULL` — by owner, subject,
relationship, object and normalized text, and folds each group into one row:

| kept                                                                                                            | folded rows                                                                            |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| earliest `valid_from`, the stronger state (confirmed beats hedged), every source episode, its own id and vector | their sources are attached to the survivor first, then their index entries and rows go |
| any row whose `superseded_by` named a folded copy is rewired to the survivor, so lineage does not dangle        | —                                                                                      |

Three properties matter more than the merge itself: it **reports by default** (`{}` writes nothing; a
bodyless POST is a 400 rather than a default-apply, so a stray request cannot cut rows), it is
**idempotent** (a second pass finds nothing), and it **never touches a row with an end date** — an open
row and a closed row of the same sentence are two eras of one claim, which is the behaviour every
point-in-time probe in sessions 1–4 depended on. Nothing is forgotten either: the retired row's source
episode keeps its content and is now cited by the survivor.

## Verified

43 tests in `src/server/memory.test.ts`, 3 new, each proved by mutating the engine:

| mutation                                | test that fails                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| dry-run gate ignored                    | both "reports before it applies" tests: served rows went 2 → 1 during a report |
| history rows included as duplicates     | "leaves an ended era out of the consolidation": `groups: 1` where 0 was right  |
| survivor ignores which row is confirmed | keeps the hedged twin instead of the confirmed row                             |
| sources not unioned                     | `expected [ … ] to have a length of 2 but got 1`                               |
| lineage not rewired                     | the older era still points at a removed id                                     |

Rehearsed on a `VACUUM INTO` snapshot of the live database before touching it: 16 invariants pass, all
34 claims keep every source, start and state, a second pass folds nothing, `integrity_check` ok,
`foreign_key_check` empty, no orphan source links or index rows, history row count unchanged, episode
count unchanged.

## Live result

Restarted `npm run dev` (authorized), confirmed the route answered, took a `VACUUM INTO` backup first
(`live-backup-20261117T150227Z.sqlite`, integrity ok), then reported every workspace through the API
and applied where the endpoint's numbers matched the database's:

| workspace     | claims | rows folded | served before → after     |
| ------------- | ------ | ----------- | ------------------------- |
| aitc          | 20     | 20          | 1156 → 1136               |
| telegramrelay | 8      | 11          | 508 → 497                 |
| pointerful    | 5      | 5           | 552 → 547                 |
| Personal      | 1      | 1           | 39 → 38                   |
| **total**     | **34** | **37**      | global served 2347 → 2310 |

Every workspace checked after: duplicates remaining 0, served fell by exactly the redundant count, no
other row removed, no history rewritten, sources and episodes intact, no orphan links or index rows, no
dangling lineage, `integrity_check` ok, `foreign_key_check` empty, second pass a no-op, and inspector,
recall and context all still answering. Redundant served rows across the install: **38 → 0**.

## Finding S — identical wording is not the same claim

Seven served rows still read the same as another row while being served twice, and they are correct:

```
Zoho CPaaS · has_payment_failure            → Mail Credits Billing $2.50
Zoho Account for support@pointerful.com · experienced_payment_failure → Mail Credits Billing $2.50
```

Different subject node, different relationship, same sentence — two claims that happen to be worded
alike (aitc 1, pointerful 5, telegramrelay 1). Both the guard and the fold key on the claim, not the
sentence, which is the module's stated rule: split entities are never merged silently and semantic
similarity alone never merges anything. If this ever bothers the eye in the inspector, the fix belongs
in the display — collapse identical text within a result set — not in the data.

## Notes for the next reader

- I restarted the app myself this session: `kill -TERM -<pgid>` on the `npm run dev` tree, relaunched
  detached, log in `mukai-stress/dev.log`. The API came back on the same port and token.
- `totalFacts` in a snapshot counts **all** rows including history, and `facts` is capped at 200 — neither
  is a served-row count. Verify row arithmetic in SQL, drive writes through the API.
- `limit` on `/memory/search` is capped at 100; above that it is a 400, which a naive harness reads as
  "nothing served". Two separate `LEFT JOIN` fan-outs in my own harnesses also invented counts (a
  "124 blocked jobs" that was really 17, and a "89 redundant rows" that was really 37). Both were the
  harness, not the engine.
- Left as the user chose: the **17 conversations with a review job blocked by the old build** (aitc 10,
  pointerful 5, telegramrelay 2), which are also the 21 abandoned review episodes. They are the only
  jobs in the install with unread messages; each is one Retry tap in Settings, and the new backoff
  governs them from then on.
- `test-workspace` was deleted on request (10 facts, 1 255 episodes, 1 bot, 10 conversations); no
  orphan rows remain for its id, and the four scratch workspaces from sessions 1–6 are gone too.
