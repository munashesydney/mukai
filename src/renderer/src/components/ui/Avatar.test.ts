import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Avatar } from './Avatar';
import { botAvatarIds, botAvatarSrc, legacyAvatarIds } from '../../../../shared/mascots';
import { botSchema } from '../../../../server/http/schemas';

describe('bot mascots', () => {
  it.each(botAvatarIds)('renders and accepts the optimized %s asset', async (avatar) => {
    const source = botAvatarSrc(avatar);
    const path = resolve('src/renderer/public', source);
    expect(existsSync(path)).toBe(true);
    const metadata = await sharp(path).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.hasAlpha).toBe(true);
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(256);
    expect(renderToStaticMarkup(createElement(Avatar, { person: avatar }))).toContain(source);
    expect(botSchema.shape.avatar.parse(avatar)).toBe(avatar);
  });

  it.each(legacyAvatarIds)('uses the logo for legacy %s avatars', (avatar) => {
    expect(renderToStaticMarkup(createElement(Avatar, { person: avatar }))).toContain(
      './mascots/mukai-logo.webp',
    );
    expect(botSchema.shape.avatar.parse(avatar)).toBe('mukai-logo');
  });

  it('falls back to the logo for unknown saved values and keeps the user avatar', () => {
    expect(botAvatarSrc('missing-mascot')).toBe('./mascots/mukai-logo.webp');
    const user = renderToStaticMarkup(createElement(Avatar, { person: 'munashe', status: true }));
    expect(user).toContain('user-profile-icon');
    expect(user).not.toContain('user-initials');
    expect(user).toContain('presence-dot');
    expect(user).not.toContain('avatar-mascot');
    expect(botSchema.shape.avatar.safeParse('missing-mascot').success).toBe(false);
  });
});
