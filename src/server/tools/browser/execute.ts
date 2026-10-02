import type { BrowserService } from '../../services/browserService';
import type { BrowserInput } from './definition';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
export function executeBrowser(
  input: BrowserInput,
  context: RuntimeToolContext & { browsers: BrowserService },
  callId: string,
) {
  return executeRuntime(
    context,
    callId,
    'browser',
    input.action,
    input.url || input.sessionId || '',
    () => {
      if (input.action === 'type' && input.text === undefined)
        throw new Error('text is required for type.');
      return context.browsers.execute(context.owner, input, context.signal);
    },
  );
}
