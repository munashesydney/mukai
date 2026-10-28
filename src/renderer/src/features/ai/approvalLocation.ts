import type { ToolApproval } from '../../../../shared/approvals';
import type { Location } from '../workspace/types';

export function approvalLocation(request: ToolApproval): Location {
  if (request.target?.kind === 'pursuit_run' && request.target.pursuitId && request.target.runId)
    return {
      section: 'pursuits',
      item: request.target.pursuitId,
      runId: request.target.runId,
      conversationId: request.conversationId,
    };
  if (request.target?.kind === 'space') return { section: 'spaces', item: request.conversationId };
  if (request.target?.kind === 'bot')
    return { section: 'bots', item: 'bot-conversations', conversationId: request.conversationId };
  return { section: 'bots', item: request.botId, conversationId: request.conversationId };
}
