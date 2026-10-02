import type { Bot } from './ai';

export const botHandle = (bot: Pick<Bot, 'name'>) =>
  bot.name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '') || 'bot';
export function mentionedBot(
  text: string,
  bots: Bot[],
  selectedId: string | null = null,
): string | null {
  const handles = [...text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)].map((match) =>
    match[1].toLowerCase(),
  );
  const candidates = bots.filter((bot) => handles.includes(botHandle(bot)));
  const uniqueHandles = new Set(candidates.map(botHandle));
  if (uniqueHandles.size > 1) throw new Error('Mention one bot at a time.');
  if (candidates.length > 1) {
    if (selectedId && candidates.some((bot) => bot.id === selectedId)) return selectedId;
    throw new Error('These bots share a name. Choose one from the mention suggestions.');
  }
  return candidates[0]?.id || null;
}
