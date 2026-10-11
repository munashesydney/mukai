export const botAvatarIds = [
  'mukai-logo',
  'muka-mascot-1-green',
  'muka-mascot-1-meroon',
  'muka-mascot-1-orange',
  'muka-mascot-1-purple',
  'muka-mascot-2-green',
  'muka-mascot-2-meroon',
  'muka-mascot-2-orange',
  'muka-mascot-2-purple',
  'muka-mascot-2-blue',
  'muka-mascot-3-blue',
  'muka-mascot-3-green',
  'muka-mascot-3-orange',
  'muka-mascot-3-purple',
  'muka-mascot-4-blue',
  'muka-mascot-5-blue',
] as const;

export type MascotId = (typeof botAvatarIds)[number];
export const legacyAvatarIds = ['scout', 'nova', 'atlas'] as const;
export type BotAvatar = MascotId | (typeof legacyAvatarIds)[number];
export const defaultBotAvatar: MascotId = 'muka-mascot-1-purple';

export const botAvatarLabels: Record<MascotId, string> = {
  'mukai-logo': 'Mukai',
  'muka-mascot-1-green': 'Green beanie and glasses',
  'muka-mascot-1-meroon': 'Maroon beret and bow tie',
  'muka-mascot-1-orange': 'Orange cowboy',
  'muka-mascot-1-purple': 'Purple wizard',
  'muka-mascot-2-green': 'Green beanie',
  'muka-mascot-2-meroon': 'Maroon ninja',
  'muka-mascot-2-orange': 'Orange headphones',
  'muka-mascot-2-purple': 'Purple cap and glasses',
  'muka-mascot-2-blue': 'Blue top hat and bow tie',
  'muka-mascot-3-blue': 'Blue beanie and glasses',
  'muka-mascot-3-green': 'Green knit hat and glasses',
  'muka-mascot-3-orange': 'Orange headphones, relaxed',
  'muka-mascot-3-purple': 'Purple headphones',
  'muka-mascot-4-blue': 'Blue cloud hat',
  'muka-mascot-5-blue': 'Blue star wizard',
};

export function resolveBotAvatar(avatar: unknown): MascotId {
  return botAvatarIds.includes(avatar as MascotId) ? (avatar as MascotId) : 'mukai-logo';
}

export function botAvatarSrc(avatar: unknown): string {
  return `./mascots/${resolveBotAvatar(avatar)}.webp`;
}
