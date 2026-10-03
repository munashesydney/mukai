import { api } from './http';
import type {
  CapabilityRegistration,
  CapabilityRun,
  EnvironmentVariable,
} from '../../../shared/customCapabilities';

export interface CapabilityDetail {
  registration: CapabilityRegistration;
  source: string;
  runs: CapabilityRun[];
  jobs: { id: string; status: string; attempts: number; error: string | null }[];
}
const scope = (workspaceId: string) => '?workspaceId=' + encodeURIComponent(workspaceId);
export const capabilityService = {
  list: (workspaceId: string) =>
    api<CapabilityRegistration[]>('/capabilities' + scope(workspaceId)),
  detail: (workspaceId: string, id: string) =>
    api<CapabilityDetail>('/capabilities/' + encodeURIComponent(id) + scope(workspaceId)),
  manage: (
    workspaceId: string,
    kind: 'tool' | 'route',
    operation: string,
    values: { id?: string; modulePath?: string; exportName?: string; ownerBotId?: string } = {},
  ) => api('/capabilities' + scope(workspaceId), 'POST', { kind, operation, ...values }),
  test: (workspaceId: string, id: string, input: unknown) =>
    api<unknown>(
      '/capabilities/' + encodeURIComponent(id) + '/test' + scope(workspaceId),
      'POST',
      input,
    ),
  environment: (workspaceId: string) =>
    api<EnvironmentVariable[]>('/environment' + scope(workspaceId)),
  saveEnvironment: (workspaceId: string, entries: { name: string; value: string }[]) =>
    api<EnvironmentVariable[]>('/environment' + scope(workspaceId), 'PUT', { entries }),
  removeEnvironment: (workspaceId: string, name: string) =>
    api('/environment/' + encodeURIComponent(name) + scope(workspaceId), 'DELETE'),
};
