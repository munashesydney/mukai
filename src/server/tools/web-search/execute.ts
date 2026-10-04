import type { WebSearchService } from '../../services/webSearchService';
import { executeRuntime, type RuntimeToolContext } from '../runtimeContext';
import type { WebSearchInput } from './definition';

export function executeWebSearch(
  input: WebSearchInput,
  context: RuntimeToolContext & { webSearch: WebSearchService },
  callId: string,
) {
  return executeRuntime(
    context,
    callId,
    'web_search',
    input.action,
    input.query || input.queries?.join(' | ') || input.urls?.join(' | ') || '',
    () => {
      // executeRuntime has already charged the first item.
      let first = true;
      return context.webSearch.execute(input, context.signal, () => {
        if (first) first = false;
        else if (--context.budget.remaining < 0)
          throw new Error('Runtime tool call limit reached. Retry only unfinished web requests.');
      });
    },
  );
}
