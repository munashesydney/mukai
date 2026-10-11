import { describe, expect, it, vi } from 'vitest';
import {
  PursuitExecution,
  PursuitScheduler,
  pausePursuitTask,
  pursuitSession,
  outsidePursuitExecution,
} from './services/pursuitScheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

describe('Shared pursuit execution slots', () => {
  it('lets detached bot work outlive its caller without inheriting the pursuit slot', async () => {
    const pool = new PursuitScheduler(() => 1);
    const finish = deferred();
    let child!: Promise<void>;
    await new PursuitExecution(pool).run(async () => {
      const parent = pursuitSession()!;
      await parent.provider(signal());
      await parent.tool(async () => {
        child = outsidePursuitExecution(async () => {
          expect(pursuitSession()).toBeUndefined();
          await finish.promise;
          expect(pursuitSession()).toBeUndefined();
          await pausePursuitTask(async () => {});
        });
        expect(pursuitSession()).toBeDefined();
      }, signal());
    });
    expect(pool.used).toBe(0);
    finish.resolve();
    await child;
    expect(pool.used).toBe(0);
  });
  it('releases a human wait and queues the exact continuation behind working pursuits', async () => {
    const pool = new PursuitScheduler(() => 1);
    const decision = deferred(),
      started = deferred(),
      otherDone = deferred();
    const resumed = vi.fn();
    const a = new PursuitExecution(pool).run(async () => {
      const session = pursuitSession()!;
      await session.provider(signal());
      await session.tool(async () => {
        await pausePursuitTask(() => {
          started.resolve();
          return decision.promise;
        });
        resumed();
      }, signal());
    });
    await started.promise;
    expect(pool.used).toBe(0);
    const working = deferred();
    const b = new PursuitExecution(pool).run(async () => {
      const session = pursuitSession()!;
      await session.provider(signal());
      working.resolve();
      await otherDone.promise;
      session.endProvider();
    });
    await working.promise;
    decision.resolve();
    await vi.waitFor(() => expect(pool.used).toBe(1));
    expect(resumed).not.toHaveBeenCalled();
    otherDone.resolve();
    await Promise.all([a, b]);
    expect(resumed).toHaveBeenCalledOnce();
    expect(pool.used).toBe(0);
  });

  it('keeps the slot while a parallel sibling still performs work', async () => {
    const pool = new PursuitScheduler(() => 1);
    const decision = deferred(),
      sibling = deferred(),
      bothStarted = deferred();
    const run = new PursuitExecution(pool).run(async () => {
      const session = pursuitSession()!;
      await session.provider(signal());
      const working = session.tool(async () => {
        bothStarted.resolve();
        await sibling.promise;
      }, signal());
      const waiting = session.tool(() => pausePursuitTask(() => decision.promise), signal());
      await Promise.all([working, waiting]);
    });
    await bothStarted.promise;
    expect(pool.used).toBe(1);
    sibling.resolve();
    await vi.waitFor(() => expect(pool.used).toBe(0));
    decision.resolve();
    await run;
    expect(pool.used).toBe(0);
  });

  it('releases delegated approval waits and reacquires before returning to the parent', async () => {
    const pool = new PursuitScheduler(() => 1);
    const question = deferred(),
      asked = deferred();
    const run = new PursuitExecution(pool).run(async () => {
      const parent = pursuitSession()!;
      await parent.provider(signal());
      await parent.tool(
        () =>
          pausePursuitTask(async () => {
            const child = pursuitSession()!;
            await child.provider(signal());
            expect(pool.used).toBe(1);
            await child.tool(
              () =>
                pausePursuitTask(() => {
                  asked.resolve();
                  return question.promise;
                }),
              signal(),
            );
          }),
        signal(),
      );
    });
    await asked.promise;
    expect(pool.used).toBe(0);
    question.resolve();
    await run;
    expect(pool.used).toBe(0);
  });

  it('caps recovered work, queues in order and honors live limit changes without stopping work', async () => {
    let limit = 2;
    const pool = new PursuitScheduler(() => limit);
    const started: number[] = [];
    const stops = Array.from({ length: 4 }, deferred);
    const runs = stops.map((stop, index) =>
      new PursuitExecution(pool).run(async () => {
        const session = pursuitSession()!;
        await session.provider(signal());
        started.push(index);
        await stop.promise;
        session.endProvider();
      }),
    );
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    limit = 1;
    pool.drain();
    stops[0].resolve();
    await runs[0];
    expect(started).toEqual([0, 1]);
    stops[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    limit = 2;
    pool.drain();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    stops[2].resolve();
    stops[3].resolve();
    await Promise.all(runs);
    expect(pool.used).toBe(0);
  });

  it('cancels a continuation waiting for capacity without running its tool', async () => {
    const pool = new PursuitScheduler(() => 1);
    const holder = new PursuitExecution(pool),
      held = deferred(),
      finish = deferred();
    const holding = holder.run(async () => {
      const session = pursuitSession()!;
      await session.provider(signal());
      held.resolve();
      await finish.promise;
      session.endProvider();
    });
    await held.promise;
    const controller = new AbortController();
    const execute = vi.fn();
    const queued = new PursuitExecution(pool).run(() =>
      pursuitSession()!.tool(async () => {
        execute();
      }, controller.signal),
    );
    const rejected = expect(queued).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(pool.used).toBe(1);
    finish.resolve();
    await holding;
    expect(pool.used).toBe(0);
  });
});
