import { z } from 'zod';

export const pursuitReportSchema = z.object({
  status: z.enum(['waiting', 'blocked', 'waiting_for_you', 'completed']),
  summary: z.string().trim().min(1).max(3000),
  nextRunAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .default(null)
    .describe(
      'Required for waiting: choose a future ISO timestamp with timezone based on what needs to happen next. Null for other outcomes.',
    ),
  nextRunReason: z
    .string()
    .trim()
    .min(1)
    .max(3000)
    .nullable()
    .default(null)
    .describe(
      'Required for waiting: explain why the next run should happen at that time. Null for other outcomes.',
    ),
  nextRunInstructions: z
    .string()
    .trim()
    .min(1)
    .max(6000)
    .nullable()
    .default(null)
    .describe(
      'Required for waiting: actionable instructions and context for the next run. Null for other outcomes.',
    ),
});

export type PursuitReport = z.infer<typeof pursuitReportSchema>;

export function pursuitReportProblem(
  report: PursuitReport | undefined,
  now: number,
  deadline: string | null,
) {
  if (!report)
    return 'This run finished without reporting a valid pursuit outcome. Call report_pursuit before finishing.';
  if (report.status !== 'waiting') {
    if (report.nextRunAt || report.nextRunReason || report.nextRunInstructions)
      return 'Only waiting schedules another run. Set nextRunAt, nextRunReason, and nextRunInstructions to null for completed, blocked, or waiting_for_you.';
    return;
  }
  if (!report.nextRunAt || !report.nextRunReason || !report.nextRunInstructions)
    return 'Waiting requires nextRunAt, nextRunReason, and actionable nextRunInstructions. Call report_pursuit with all three, or report the actual completed or blocked outcome.';
  if (Date.parse(report.nextRunAt) <= now)
    return 'nextRunAt must be in the future. Choose a useful next wake based on the remaining work and call report_pursuit again.';
  if (deadline && Date.parse(report.nextRunAt) >= Date.parse(deadline))
    return 'nextRunAt must be before the pursuit deadline. Choose an earlier wake or report blocked if progress cannot continue before the deadline.';
}
