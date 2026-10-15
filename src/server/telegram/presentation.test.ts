import { describe, expect, it } from 'vitest';
import { telegramBodyLimit, telegramMessage } from './presentation';
import { splitTelegramText } from './commands';

describe('Telegram-only workspace headers', () => {
  it('labels global setup and control messages without inventing a selected workspace', () => {
    expect(telegramMessage('Choose a workspace.')).toBe(
      'Workspace Not selected\n\nChoose a workspace.',
    );
  });
  it('keeps every split message within Telegram limits without losing answer text', () => {
    const answer = 'Full answer 📨\n'.repeat(1500);
    const prefix = telegramMessage('', 'A'.repeat(120), 'B'.repeat(120));
    const messages = splitTelegramText(answer, telegramBodyLimit).map((part) =>
      telegramMessage(part, 'A'.repeat(120), 'B'.repeat(120)),
    );
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((part) => part.startsWith(prefix) && part.length <= 4096)).toBe(true);
    expect(messages.map((part) => part.slice(prefix.length)).join('')).toBe(answer);
    expect(messages.some((part) => /[\uD800-\uDBFF]$/.test(part))).toBe(false);
  });
  it('puts the bot immediately below the workspace, keeping both names on one line', () => {
    expect(telegramMessage('Hello!', 'Project', 'Scout\nAnother label')).toBe(
      'Workspace Project\nBot Scout Another label\n\nHello!',
    );
  });
  it('keeps workspace names on a single header line and trims streaming tails safely', () => {
    const text = telegramMessage('😀'.repeat(3000), 'Project\nOther header');
    expect(text.startsWith('Workspace Project Other header\n\n')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(/^[\uDC00-\uDFFF]/.test(text.split('\n\n')[1])).toBe(false);
  });
});
