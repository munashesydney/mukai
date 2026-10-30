import mukaiCustomRoutesAuthenticatedWebsites from './mukai-custom-routes-authenticated-websites';
import mukaiApiReference from './mukai-api-reference';
import mukaiWebhooks from './mukai-webhooks';
import type { SkillBundle } from '../shared/skills';

/** Default skill folders shipped with every Mukai distribution. */
export const defaultSkills: readonly SkillBundle[] = [
  mukaiCustomRoutesAuthenticatedWebsites,
  mukaiApiReference,
  mukaiWebhooks,
];
