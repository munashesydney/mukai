import { describe, expect, it } from 'vitest';
import type { Bot } from './ai';
import { botHandle, mentionedBot } from './mentions';
const bot = (id: string, name: string) => ({ id, name }) as Bot;
describe('Bot mentions', () => {
  it('resolves workspace bot IDs from names, respecting boundaries and membership', () => {
    const bots = [bot('random-id', 'Scout'), bot('writer', 'Helpful Writer')];
    expect(mentionedBot('@Scout wasup man', bots)).toBe('random-id');
    expect(botHandle(bots[1])).toBe('helpful-writer');
    expect(mentionedBot('@helpful-writer hi', bots)).toBe('writer');
    expect(mentionedBot('contact user@scout.com', bots)).toBeNull();
    expect(mentionedBot('@atlas hi', bots)).toBeNull();
    expect(mentionedBot('Hi', bots, 'random-id')).toBeNull();
    expect(() => mentionedBot('@scout @helpful-writer hi', bots)).toThrow('one bot');
  });
  it('requires selecting an ID for duplicate names', () => {
    const bots = [bot('one', 'Scout'), bot('two', 'Scout')];
    expect(() => mentionedBot('@scout hi', bots)).toThrow('share a name');
    expect(mentionedBot('@scout hi', bots, 'two')).toBe('two');
  });
});
