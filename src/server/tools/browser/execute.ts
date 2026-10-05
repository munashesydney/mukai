import type { BrowserService } from '../../services/browserService';
import type { BrowserInput } from './definition';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
import type { ArtifactService } from '../../services/artifactService';
export function executeBrowser(
  input: BrowserInput,
  context: RuntimeToolContext & {
    browsers: BrowserService;
    saveScreenshot?: (image: string) => ReturnType<ArtifactService['recordScreenshot']>;
  },
  callId: string,
) {
  return executeRuntime(
    context,
    callId,
    'browser',
    input.action,
    input.url || input.sessionId || '',
    async () => {
      if (input.action === 'type' && input.text === undefined)
        throw new Error('text is required for type.');
      const result = await context.browsers.execute(context.owner, input, context.signal);
      if (
        input.action === 'screenshot' &&
        result &&
        typeof result === 'object' &&
        'image' in result &&
        typeof result.image === 'string' &&
        context.saveScreenshot
      ) {
        const saved = await context.saveScreenshot(result.image);
        return {
          ...result,
          ...saved,
          screenshotUrl: '/artifacts/' + saved.artifactId,
          imageIncluded: false,
          imageDelivery: 'pending',
        };
      }
      return result;
    },
  );
}
