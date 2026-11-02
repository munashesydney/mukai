export interface LimitsSettings {
  pursuitConcurrency: number;
  aiConcurrency: number;
}
export const DEFAULT_AI_CONCURRENCY = 4;
export const MAX_AI_CONCURRENCY = 50;
export const DEFAULT_PURSUIT_CONCURRENCY = 5;
export const MAX_PURSUIT_CONCURRENCY = 50;
