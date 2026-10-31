import { api, apiFetch } from './http';
import type {
  CapabilityRegistration,
  CapabilityRun,
  EnvironmentVariable,
  CustomToolPermissionMode,
  CustomToolPresentation,
} from '../../../shared/customCapabilities';

export interface CapabilityDetail {
  registration: CapabilityRegistration;
  source: string;
  runs: CapabilityRun[];
  jobs: { id: string; status: string; attempts: number; error: string | null }[];
}
const scope = (workspaceId: string) => '?workspaceId=' + encodeURIComponent(workspaceId);
export const capabilityService = {
  routeSettings: () =>
    api<{ publicBaseUrl: string; localBaseUrl: string }>('/capabilities/settings'),
  saveRouteSettings: (publicBaseUrl: string) =>
    api<{ publicBaseUrl: string; localBaseUrl: string }>('/capabilities/settings', 'PUT', {
      publicBaseUrl,
    }),
  list: (workspaceId: string) =>
    api<CapabilityRegistration[]>('/capabilities' + scope(workspaceId)),
  detail: (workspaceId: string, id: string) =>
    api<CapabilityDetail>('/capabilities/' + encodeURIComponent(id) + scope(workspaceId)),
  manage: (
    workspaceId: string,
    kind: 'tool' | 'route' | 'job',
    operation: string,
    values: {
      id?: string;
      modulePath?: string;
      exportName?: string;
      ownerBotId?: string;
      permissionMode?: CustomToolPermissionMode;
      presentation?: CustomToolPresentation | null;
    } = {},
  ) => api('/capabilities' + scope(workspaceId), 'POST', { kind, operation, ...values }),
  test: (workspaceId: string, id: string, input: unknown) =>
    api<unknown>(
      '/capabilities/' + encodeURIComponent(id) + '/test' + scope(workspaceId),
      'POST',
      input,
    ),
  environment: (workspaceId: string) =>
    api<EnvironmentVariable[]>('/environment' + scope(workspaceId)),
  saveEnvironment: (
    workspaceId: string,
    entries: { name: string; value: string; secret?: boolean }[],
  ) => api<EnvironmentVariable[]>('/environment' + scope(workspaceId), 'PUT', { entries }),
  setEnvironmentSensitivity: (workspaceId: string, name: string, secret: boolean) =>
    api<EnvironmentVariable[]>(
      '/environment/' + encodeURIComponent(name) + scope(workspaceId),
      'PATCH',
      { secret },
    ),
  exportEnvironment: async (workspaceId: string) => {
    const response = await apiFetch('/environment/export' + scope(workspaceId), { method: 'POST' });
    return response.blob();
  },
  removeEnvironment: (workspaceId: string, name: string) =>
    api('/environment/' + encodeURIComponent(name) + scope(workspaceId), 'DELETE'),
};
