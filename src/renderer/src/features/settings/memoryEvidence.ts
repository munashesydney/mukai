import type { Episode } from '../../../../shared/memory';

export const memorySourceLabel: Record<Episode['sourceType'], string> = {
  user: 'Conversation',
  tool: 'Bot tool',
  manual: 'Manual entry',
  correction: 'Correction',
  import: 'Import',
};

type EvidenceMessage = {
  role: string;
  origin?: string;
  content: string;
  evidence?: { tool: string; status: string; result: string }[];
};

export function reviewMessages(episode: Episode): EvidenceMessage[] {
  if (!episode.sourceKey.startsWith('review:') || !episode.content) return [];
  try {
    const { messages } = JSON.parse(episode.content);
    if (!Array.isArray(messages)) return [];
    return messages.filter(
      (message): message is EvidenceMessage =>
        typeof message?.role === 'string' && typeof message.content === 'string',
    );
  } catch {
    return [];
  }
}
