import type { BrowserBounds, BrowserSession, ChromeProfile } from '../../shared/runtime';
export interface BrowserPage {
  profile?: ChromeProfile;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  isClosed(): boolean;
}
export interface EmbeddedBrowserHost {
  open(info: BrowserSession): Promise<BrowserPage>;
  bounds(value: BrowserBounds | null): void;
  shutdown(): Promise<void>;
}

export async function browserCommand<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Browser command timed out. Show the tab and take a fresh snapshot before retrying.',
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
