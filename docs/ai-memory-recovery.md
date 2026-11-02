# AI queue and memory recovery

Mukai uses one shared queue for AI work across all workspaces. When a provider such as oMLX rejects a request because of memory pressure, Mukai can wait, temporarily reduce concurrency for that server, and retry from saved progress. The chat explains what is happening throughout recovery.

## Normal queue behavior

**Settings → Limits → Maximum concurrent AIs** sets the global maximum, initially **4**. Chats, pursuits, memory extraction, local embeddings, context compaction, and provider connection tests share this pool.

A slot covers a model request. It is released when that request ends, including a model step that hands off to tools. Tool execution, human approvals, and waiting for delegated bots do not hold inference slots. Consequently, chats can take turns between model steps while remaining visibly underway.

With a limit of one, another chat waits while the current model request generates. When that request ends, queued work may take the next slot before the first chat's next model step.

The inline notice appears after the latest message in the waiting chat and scrolls with its history. It shows queue position, running workspaces, and a link to Limits. Ordinary queue waiting does not consume the chat's provider watchdog budget.

## What triggers memory recovery

Mukai recognizes provider memory-protection errors before streaming starts and errors delivered during streaming. Supported structured codes include:

- `prefill_memory_exceeded`
- `generation_memory_guard`
- `memory_admission_stalled`
- `store_cache_admission_stalled`

Recognized oMLX memory-guard messages are also supported. Wrapped errors and structured HTTP error bodies are inspected.

Memory pressure is handled separately from exceeding a model's token context window. A prompt can fit the configured token window but still require more memory than the provider permits.

## Recovery sequence

1. **Preserve progress.** Earlier completed tool calls and their results stay saved.
2. **Reduce the affected server's allowance.** Each memory rejection halves its previous allowance, rounded down, with a minimum of one. For example, a maximum of four can temporarily become two, then one. Existing requests are allowed to finish.
3. **Cool down through the queue.** The first rejection waits 60 seconds, the next 120 seconds, and subsequent rejections 180 seconds. Cooling requests occupy no inference slot. The cooldown is shared by requests to the affected server, so another rejection can extend a waiting request's delay.
4. **Retry a safe model step.** A chat can make up to three automatic memory retries. Earlier successful tool operations are not repeated. A generation that already started tool execution, or has pending tool decisions, is not automatically replayed.
5. **Try a smaller context once.** If those retries fail, Mukai requests compaction. It makes one final model attempt only if the context was reduced.
6. **Stop if recovery is exhausted.** The response shows an accurate memory error and its saved-progress report. An explicit user retry can start a fresh recovery attempt.

The initial failed request is separate from the three retries. Memory extraction, compaction, and connection tests have their own bounded three-retry budgets. Generic SDK network retries do not multiply these memory retry budgets.

The waiting times are backoff intervals, not a total completion-time guarantee: generation, compaction, other queued requests, and additional server failures can add time.

## Saved limit versus temporary allowance

Recovery **does not change the saved Settings value**. The temporary allowance applies to the affected provider server and is always constrained by the saved global maximum.

Compatible-provider registrations using the same endpoint share the temporary allowance, including localhost and loopback-IP aliases. Requests to other ready providers can proceed while that server cools, within the global limit. FIFO order is preserved among eligible requests.

| State                     | Saved global maximum | Temporary server allowance |
| ------------------------- | -------------------: | -------------------------: |
| Normal                    |                    4 |   Up to the global maximum |
| First memory rejection    |                    4 |                          2 |
| Repeated memory rejection |                    4 |                          1 |
| Recovery                  |                    4 | Gradually returns toward 4 |

After **two minutes without a memory rejection** and **at least three successful requests**, the server allowance increases by one. Further groups of three successful requests increase it again until it reaches the configured maximum. The temporary state clears when the backend restarts.

## What the user sees

The same inline queue notice explains the current stage:

- **Waiting for memory recovery** with a countdown such as “Retry in 29s · Retry 1/3.”
- **Retrying after memory rejection** while a recovery request is active.
- **Trying a smaller context** during the final compaction recovery stage.

It also identifies the affected provider and explains the temporary allowance alongside the saved maximum. **Settings → Limits** displays the temporary recovery state while keeping the configured input value unchanged.

The Limits link remains available during recovery. Stop cancels a queued retry without submitting another provider request. Other chats are not cancelled to make room.

## Limits of recovery

Waiting and lower concurrency can help temporary pressure. They cannot guarantee that an individual request fits: a large loaded model and a long context can still exceed the provider's memory guard at concurrency one.

This feature does not clear caches, unload models, restart oMLX, or raise operating-system memory limits. When recovery is exhausted, the user can inspect provider memory use, free resources, or reduce the model context before retrying. Saved history and completed results remain available.

## Implementation and verification

- Queue, temporary server caps, cooldowns, and restoration: [aiConcurrency.ts](../src/server/services/aiConcurrency.ts).
- Error recognition and recovery constants: [memoryRecovery.ts](../src/server/services/memoryRecovery.ts).
- Chat continuation, checkpoints, and smaller-context recovery: [chatService.ts](../src/server/services/chatService.ts).
- Chat feedback: [AIQueueNotice.tsx](../src/renderer/src/features/ai/AIQueueNotice.tsx).
- Settings feedback: [LimitsPanel.tsx](../src/renderer/src/features/settings/LimitsPanel.tsx).

Regression coverage includes HTTP and streamed failures, retry exhaustion, cancellation, shared-server aliases, unaffected providers, gradual restoration, unchanged saved limits, and preventing repeated tool execution. Browser checks cover countdowns, recovery messages, Settings feedback, and mobile layout.
