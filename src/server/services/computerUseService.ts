import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { z } from 'zod';
import type { RuntimeOwner } from '../../shared/runtime';
import {
  computerUseDefinition,
  validateComputerUse,
  type ComputerUseInput,
} from '../tools/computer_use/definition';
import {
  displaySchema,
  parseKeys,
  type DesktopBackend,
  type DesktopDisplay,
} from '../computer/computer_use/protocol';
import { NativeDesktopBackend } from '../computer/computer_use/nativeBackend';

interface Capture {
  owner: string;
  display: DesktopDisplay;
  width: number;
  height: number;
  expires: number;
}
const ownerKey = (owner: RuntimeOwner) =>
  JSON.stringify([owner.workspaceId, owner.botId, owner.conversationId]);
const geometry = (display: DesktopDisplay) => JSON.stringify(display);

/** One instance per physical desktop, shared by all local workspaces or by one guest. */
export class ComputerUseService {
  private tail: Promise<unknown> = Promise.resolve();
  private captures = new Map<string, Capture>();
  private keys = new Set<string>();
  private buttons = new Set<'left' | 'right' | 'middle'>();
  private holdOwner?: string;
  private holdTimer?: NodeJS.Timeout;
  private holdCleanup?: () => void;
  private leaseVersion = 0;
  private closed = false;
  private lifetime = new AbortController();

  constructor(private backend: DesktopBackend = new NativeDesktopBackend()) {}

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }
  private async release() {
    clearTimeout(this.holdTimer);
    this.holdCleanup?.();
    this.holdCleanup = undefined;
    this.leaseVersion++;
    this.holdOwner = undefined;
    if (!this.keys.size && !this.buttons.size) return;
    // Cleanup must work even when the caller was aborted or the helper was restarted.
    const signal = AbortSignal.timeout(5000);
    const failures: unknown[] = [];
    for (const key of [...this.keys].reverse()) {
      try {
        await this.backend.request({ action: 'key', key, down: false }, signal);
        this.keys.delete(key);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const button of [...this.buttons]) {
      try {
        await this.backend.request({ action: 'button', button, down: false }, signal);
        this.buttons.delete(button);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new Error('Desktop input cleanup failed. Check the desktop before retrying.');
  }
  private lease(owner: string, signal: AbortSignal) {
    this.holdOwner = owner;
    clearTimeout(this.holdTimer);
    this.holdCleanup?.();
    const version = ++this.leaseVersion;
    const expire = () => {
      void this.serialize(async () => {
        if (this.leaseVersion === version) await this.release();
      }).catch(() => {});
    };
    signal.addEventListener('abort', expire, { once: true });
    this.holdCleanup = () => signal.removeEventListener('abort', expire);
    this.holdTimer = setTimeout(expire, 10000);
    this.holdTimer.unref();
  }
  private async displays(signal: AbortSignal) {
    const value = z
      .object({ displays: z.array(displaySchema).min(1).max(32) })
      .parse(await this.backend.request({ action: 'displays' }, signal));
    return value.displays;
  }
  private point(
    input: ComputerUseInput,
    owner: string,
    displays: DesktopDisplay[],
    x: number,
    y: number,
  ) {
    let display: DesktopDisplay | undefined;
    if (input.screenshotId) {
      const capture = this.captures.get(input.screenshotId);
      if (!capture || capture.owner !== owner || capture.expires < Date.now())
        throw new Error(
          'Screenshot is expired or belongs to another conversation. Take a new screenshot.',
        );
      display = displays.find((candidate) => candidate.id === capture.display.id);
      if (!display || geometry(display) !== geometry(capture.display))
        throw new Error('Display configuration changed. Take a new screenshot.');
      if (x < 0 || y < 0 || x >= capture.width || y >= capture.height)
        throw new Error('Coordinates are outside the screenshot.');
      x = display.x + (x * display.width) / capture.width;
      y = display.y + (y * display.height) / capture.height;
    } else if (input.displayId) {
      display = displays.find((candidate) => candidate.id === input.displayId);
      if (!display) throw new Error('Display not found. Call displays again.');
      x += display.x;
      y += display.y;
    }
    display ||= displays.find(
      (candidate) =>
        x >= candidate.x &&
        y >= candidate.y &&
        x < candidate.x + candidate.width &&
        y < candidate.y + candidate.height,
    );
    if (
      !display ||
      x < display.x ||
      y < display.y ||
      x >= display.x + display.width ||
      y >= display.y + display.height
    )
      throw new Error('Coordinates are outside the selected display.');
    return { action: 'move' as const, x, y, displayId: display.id };
  }

  execute(owner: RuntimeOwner, raw: ComputerUseInput, callerSignal: AbortSignal): Promise<unknown> {
    const input = validateComputerUse(computerUseDefinition.inputSchema.parse(raw));
    const identity = ownerKey(owner);
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    return this.serialize(async () => {
      signal.throwIfAborted();
      if (this.closed) throw new Error('Computer use is shutting down.');
      if (this.holdOwner && this.holdOwner !== identity) await this.release();
      try {
        if (input.action === 'status')
          return await this.backend.request({ action: 'status' }, signal);
        if (input.action === 'displays') return { displays: await this.displays(signal) };
        if (input.action === 'cursor')
          return await this.backend.request({ action: 'cursor' }, signal);
        if (input.action === 'wait') {
          await delay(input.durationMs!, undefined, { signal });
          return { waitedMs: input.durationMs };
        }
        if (input.action === 'screenshot') {
          const displays = await this.displays(signal);
          const display = input.displayId
            ? displays.find((value) => value.id === input.displayId)
            : displays.find((value) => value.primary) || displays[0];
          if (!display) throw new Error('Display not found. Call displays again.');
          const raw = z
            .object({ image: z.string().max(24 * 1024 * 1024) })
            .parse(
              await this.backend.request({ action: 'screenshot', displayId: display.id }, signal),
            );
          const source = Buffer.from(raw.image, 'base64');
          const { data, info } = await sharp(source, { limitInputPixels: 40000000 })
            .resize({
              width: input.maxDimension ?? 1920,
              height: input.maxDimension ?? 1920,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer({ resolveWithObject: true });
          signal.throwIfAborted();
          const current = (await this.displays(signal)).find((value) => value.id === display.id);
          if (!current || geometry(current) !== geometry(display))
            throw new Error('Display changed during capture. Retry screenshot.');
          for (const [id, capture] of this.captures)
            if (capture.expires < Date.now()) this.captures.delete(id);
          while (this.captures.size >= 64) this.captures.delete(this.captures.keys().next().value!);
          const screenshotId = randomUUID();
          this.captures.set(screenshotId, {
            owner: identity,
            display,
            width: info.width,
            height: info.height,
            expires: Date.now() + 300000,
          });
          return {
            image: data.toString('base64'),
            mediaType: 'image/png',
            screenshotId,
            width: info.width,
            height: info.height,
            display,
            coordinateMapping: {
              originX: display.x,
              originY: display.y,
              logicalUnitsPerPixelX: display.width / info.width,
              logicalUnitsPerPixelY: display.height / info.height,
            },
          };
        }
        if (['move', 'click', 'drag', 'scroll'].includes(input.action)) {
          const displays = await this.displays(signal);
          // Validate the entire gesture before moving or pressing anything.
          const start =
            input.x !== undefined
              ? this.point(input, identity, displays, input.x, input.y!)
              : undefined;
          const end =
            input.action === 'drag'
              ? this.point(input, identity, displays, input.endX!, input.endY!)
              : undefined;
          if (start) await this.backend.request(start, signal);
          if (input.action === 'click' || input.action === 'drag') {
            const button = input.button ?? 'left';
            for (
              let click = 0;
              click < (input.action === 'drag' ? 1 : (input.clicks ?? 1));
              click++
            ) {
              this.buttons.add(button);
              await this.backend.request({ action: 'button', button, down: true }, signal);
              if (end && start) {
                const duration = input.durationMs ?? 500;
                const steps = Math.max(1, Math.ceil(duration / 20));
                for (let step = 1; step <= steps; step++) {
                  await delay(duration / steps, undefined, { signal });
                  const x = start.x + ((end.x - start.x) * step) / steps;
                  const y = start.y + ((end.y - start.y) * step) / steps;
                  const display = displays.find(
                    (value) =>
                      x >= value.x &&
                      y >= value.y &&
                      x < value.x + value.width &&
                      y < value.y + value.height,
                  );
                  if (display)
                    await this.backend.request(
                      { action: 'move', x, y, displayId: display.id },
                      signal,
                    );
                }
              } else await delay(40, undefined, { signal });
              await this.backend.request({ action: 'button', button, down: false }, signal);
              this.buttons.delete(button);
              if (click + 1 < (input.clicks ?? 1)) await delay(80, undefined, { signal });
            }
          }
          if (input.action === 'scroll') {
            const amount = input.pixels ?? 500;
            const dx =
              input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0;
            const dy = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0;
            await this.backend.request({ action: 'scroll', dx, dy }, signal);
          }
          signal.throwIfAborted();
          return { action: input.action, ...(end || start ? { cursor: end || start } : {}) };
        }
        if (input.action === 'type') {
          if (this.keys.size) throw new Error('Release held keys before typing literal text.');
          const characters = Array.from(input.text!);
          for (let offset = 0; offset < characters.length; offset += 32) {
            signal.throwIfAborted();
            await this.backend.request(
              { action: 'type', text: characters.slice(offset, offset + 32).join('') },
              signal,
            );
          }
        } else {
          const keys = parseKeys(input.key!);
          if (input.action !== 'press' && keys.length !== 1)
            throw new Error('key_down/key_up require one key.');
          if (input.action === 'key_up') {
            await this.backend.request({ action: 'key', key: keys[0], down: false }, signal);
            this.keys.delete(keys[0]);
          } else {
            const fresh = keys.filter((key) => !this.keys.has(key));
            for (const key of fresh) {
              this.keys.add(key);
              await this.backend.request({ action: 'key', key, down: true }, signal);
            }
            if (input.action === 'press') {
              await delay(30, undefined, { signal });
              for (const key of fresh.reverse()) {
                await this.backend.request({ action: 'key', key, down: false }, signal);
                this.keys.delete(key);
              }
            }
          }
          if (this.keys.size) this.lease(identity, signal);
          else {
            clearTimeout(this.holdTimer);
            this.holdCleanup?.();
            this.holdCleanup = undefined;
            this.leaseVersion++;
            this.holdOwner = undefined;
          }
        }
        signal.throwIfAborted();
        return { action: input.action, heldKeys: [...this.keys] };
      } catch (error) {
        try {
          await this.release();
          if (input.action === 'type')
            await this.backend.request({ action: 'release' }, AbortSignal.timeout(5000));
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            `${error instanceof Error ? error.message : 'Desktop operation failed.'} Input cleanup failed.`,
          );
        }
        throw error;
      }
    });
  }
  async shutdown() {
    this.closed = true;
    this.lifetime.abort();
    clearTimeout(this.holdTimer);
    try {
      await this.serialize(() => this.release());
    } finally {
      this.captures.clear();
      await this.backend.shutdown();
    }
  }
}
