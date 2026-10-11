import type { Bot, ChatMessage, FileArtifact } from '../../../../shared/ai';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import type { ChatServerOutput } from '../../../../shared/chatActivity';

export function chatActivityData(
  messages: ChatMessage[],
  outputs: ChatServerOutput[],
  artifacts: FileArtifact[],
  bots: Bot[],
) {
  const finished = messages.filter(
    (message) => message.role === 'assistant' && message.status !== 'streaming',
  );
  const ids = new Set(finished.map((message) => message.id));
  const changes = new Map<string, FileChangeSummary>();
  const delegated = new Map<
    string,
    NonNullable<NonNullable<ChatMessage['activity']>[number]['delegation']>
  >();
  const created = new Set<string>();
  for (const message of finished) {
    for (const change of message.changes || []) changes.set(change.path, change);
    for (const activity of message.activity || []) {
      if (activity.createdBotId && activity.status === 'complete')
        created.add(activity.createdBotId);
      if (activity.delegation)
        delegated.set(activity.delegation.conversationId, activity.delegation);
    }
  }
  const files = new Map<string, FileArtifact>();
  for (const artifact of artifacts)
    if (ids.has(artifact.messageId)) files.set(artifact.path, artifact);
  const servers = new Map<string, ChatServerOutput>();
  for (const output of outputs) if (ids.has(output.messageId)) servers.set(output.url, output);
  const spawned = [...created]
    .filter((id) => ![...delegated.values()].some((item) => item.botId === id))
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is Bot => Boolean(bot));
  const result = {
    changes: [...changes.values()],
    delegated: [...delegated.values()],
    spawned,
    outputs: [...servers.values()],
    artifacts: [...files.values()],
  };
  return {
    ...result,
    count:
      result.changes.length +
      result.delegated.length +
      result.spawned.length +
      result.outputs.length +
      result.artifacts.length,
  };
}
