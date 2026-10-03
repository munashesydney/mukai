import { api } from './http';
import type { SkillBundle, SkillDetail, SkillInfo } from '../../../shared/skills';
const scope = (workspaceId: string) => '?workspaceId=' + encodeURIComponent(workspaceId);
async function skillsApi<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  try {
    return await api<T>(path, method, value);
  } catch (error) {
    if (error instanceof Error && error.message === 'Not found')
      throw new Error(
        'The running server does not support Skills yet. Fully close and restart Mukai (or stop and restart npm run dev), then try again.',
      );
    throw error;
  }
}
export const skillService = {
  list: (workspaceId: string) => skillsApi<SkillInfo[]>('/skills' + scope(workspaceId)),
  inspect: (workspaceId: string, id: string) =>
    skillsApi<SkillDetail>('/skills/' + encodeURIComponent(id) + scope(workspaceId)),
  preview: (workspaceId: string, url: string) =>
    skillsApi<SkillBundle>('/skills/preview' + scope(workspaceId), 'POST', { url }),
  save: (workspaceId: string, bundle: SkillBundle, id?: string, expectedVersion?: string) =>
    id
      ? skillsApi<SkillDetail>('/skills/' + encodeURIComponent(id) + scope(workspaceId), 'PUT', {
          bundle,
          expectedVersion,
        })
      : skillsApi<SkillDetail>('/skills' + scope(workspaceId), 'POST', bundle),
  enable: (workspaceId: string, id: string, enabled: boolean) =>
    skillsApi<SkillDetail>(
      '/skills/' + encodeURIComponent(id) + '/enabled' + scope(workspaceId),
      'PUT',
      {
        enabled,
      },
    ),
  remove: (workspaceId: string, id: string) =>
    skillsApi('/skills/' + encodeURIComponent(id) + scope(workspaceId), 'DELETE'),
};
