import type { LimitsSettings } from '../../../shared/limits';
import { api } from './http';

export const limitsService = {
  get: () => api<LimitsSettings>('/limits'),
  save: (value: LimitsSettings) => api<LimitsSettings>('/limits', 'PUT', value),
};
