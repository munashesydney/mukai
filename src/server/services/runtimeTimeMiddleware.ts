import type { LanguageModelMiddleware } from 'ai';
import { botRuntimeClock, isBotRuntimeContext } from '../../shared/botSystemPrompt';

/** Install inside the concurrency middleware so queued requests get a dispatch-time clock. */
export function runtimeTimeMiddleware(
  timeZone: () => string,
  now = () => new Date().toISOString(),
  onStamp?: (source: string, stamped: string) => void,
): LanguageModelMiddleware {
  let source: string | undefined;
  let stamped: string | undefined;
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      for (let index = params.prompt.length - 1; index >= 0; index--) {
        const message = params.prompt[index];
        if (message.role !== 'user') continue;
        const partIndex = message.content.findIndex(
          (part) => part.type === 'text' && isBotRuntimeContext(part.text),
        );
        const part = message.content[partIndex];
        if (part?.type !== 'text') continue;
        if (source !== part.text && stamped !== part.text) {
          source = part.text;
          stamped = part.text.replace(
            /\[Mukai workspace clock\][\s\S]*?\[\/Mukai workspace clock\]/,
            () => botRuntimeClock(now(), timeZone()),
          );
        }
        if (part.text !== stamped) onStamp?.(part.text, stamped!);
        // Do not mutate checkpoints or earlier history. SDK transport retries reuse this stamp.
        const prompt = [...params.prompt];
        const content = [...message.content];
        content[partIndex] = { ...part, text: stamped! };
        prompt[index] = { ...message, content };
        return { ...params, prompt };
      }
      return params;
    },
  };
}
