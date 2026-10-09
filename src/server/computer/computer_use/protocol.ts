import { z } from 'zod';

export const displaySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  pixelWidth: z.number().positive(),
  pixelHeight: z.number().positive(),
  primary: z.boolean(),
});
export type DesktopDisplay = z.infer<typeof displaySchema>;
export type DesktopCommand =
  | { action: 'status' | 'displays' | 'cursor' | 'release' }
  | { action: 'screenshot'; displayId: string }
  | { action: 'move'; x: number; y: number; displayId?: string }
  | { action: 'button'; button: 'left' | 'right' | 'middle'; down: boolean }
  | { action: 'key'; key: string; down: boolean }
  | { action: 'type'; text: string }
  | { action: 'scroll'; dx: number; dy: number };
export interface DesktopBackend {
  request(input: DesktopCommand, signal: AbortSignal): Promise<unknown>;
  shutdown(): Promise<void>;
}

const aliases: Record<string, string> = {
  CONTROL: 'CTRL',
  COMMAND: 'CMD',
  META: 'SUPER',
  WIN: 'SUPER',
  WINDOWS: 'SUPER',
  OPTION: 'ALT',
  RETURN: 'ENTER',
  ESC: 'ESCAPE',
  SPACEBAR: 'SPACE',
  ARROWUP: 'UP',
  ARROWDOWN: 'DOWN',
  ARROWLEFT: 'LEFT',
  ARROWRIGHT: 'RIGHT',
  DEL: 'DELETE',
  PGUP: 'PAGEUP',
  PGDN: 'PAGEDOWN',
};
const named = new Set([
  'CTRL',
  'CMD',
  'SUPER',
  'ALT',
  'SHIFT',
  'ENTER',
  'ESCAPE',
  'TAB',
  'BACKSPACE',
  'DELETE',
  'SPACE',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'HOME',
  'END',
  'PAGEUP',
  'PAGEDOWN',
  'INSERT',
  'CAPSLOCK',
]);
export function parseKeys(value: string, platform = process.platform) {
  const keys = value.split('+').map((part) => {
    let key = part.trim().toUpperCase();
    key = aliases[key] || key;
    if (key === 'CMD') key = platform === 'darwin' ? 'SUPER' : 'CTRL';
    if (platform === 'darwin' && /^F2[1-4]$/.test(key)) throw new Error('macOS supports F1–F20.');
    if (!named.has(key) && !/^[A-Z0-9]$/.test(key) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key))
      throw new Error(`Unsupported key: ${part}. Use named keys, letters, digits or F1–F24.`);
    return key;
  });
  if (keys.length > 5 || new Set(keys).size !== keys.length) throw new Error('Invalid key chord.');
  if (keys.slice(0, -1).some((key) => !['CTRL', 'ALT', 'SHIFT', 'SUPER'].includes(key)))
    throw new Error('Only modifiers may precede the final key.');
  return keys;
}
