import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database';
import {
  scheduledStatus,
  type Pursuit,
  type PursuitInput,
  type PursuitRun,
  type PursuitStatus,
} from '../../shared/pursuits';
import { pursuitReportProblem, type PursuitReport } from '../tools/pursuits/report';

export class PursuitRepository {
  constructor(private database: Database) {}
  private project(row: Row): Pursuit {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      objective: String(row.objective),
      successCriteria: String(row.success_criteria),
      ownerBotId: row.owner_bot_id as string | null,
      status: row.status as PursuitStatus,
      deadline: row.deadline as string | null,
      nextRunAt: row.next_run_at as string | null,
      nextRunReason: String(row.next_run_reason),
      nextRunInstructions: String(row.next_run_instructions),
      createdAt: String(row.created_at),
      currentRunId:
        (this.database.get(
          "SELECT id FROM pursuit_runs WHERE pursuit_id=? AND status='running'",
          String(row.id),
        )?.id as string) || null,
    };
  }
  find(id: string) {
    const row = this.database.get('SELECT * FROM pursuits WHERE id=?', id);
    return row ? this.project(row) : undefined;
  }
  list(workspaceId: string) {
    return this.database
      .all('SELECT * FROM pursuits WHERE workspace_id=? ORDER BY created_at,rowid', workspaceId)
      .map((row) => this.project(row));
  }
  create(workspaceId: string, ownerBotId: string, input: PursuitInput, now: number) {
    const id = randomUUID();
    this.database.transaction(() => {
      this.database.run(
        // Retain the legacy interval column and existing values for compatibility;
        // scheduling no longer reads it.
        "INSERT INTO pursuits(id,workspace_id,name,objective,success_criteria,owner_bot_id,status,interval_minutes,deadline,next_run_at,next_run_reason,created_at,next_run_instructions) VALUES(?,?,?,?,?,?,'active',1,?,?,'First pursuit run',?,?)",
        id,
        workspaceId,
        input.name,
        input.objective,
        input.successCriteria,
        ownerBotId,
        input.deadline,
        input.firstRunAt || new Date(now).toISOString(),
        new Date(now).toISOString(),
        input.objective,
      );
    });
    return this.find(id)!;
  }
  update(id: string, input: PursuitInput, now: number) {
    const pursuit = this.find(id)!;
    this.database.transaction(() => {
      const next = scheduledStatus(pursuit.status)
        ? input.firstRunAt || new Date(now).toISOString()
        : null;
      this.database.run(
        'UPDATE pursuits SET name=?,objective=?,success_criteria=?,deadline=?,next_run_at=?,next_run_reason=?,next_run_instructions=? WHERE id=?',
        input.name,
        input.objective,
        input.successCriteria,
        input.deadline,
        next,
        next ? 'Schedule updated' : pursuit.nextRunReason,
        input.objective,
        id,
      );
    });
    return this.find(id)!;
  }
  setStatus(id: string, status: PursuitStatus, reason: string, now: number) {
    this.database.run(
      'UPDATE pursuits SET status=?,next_run_at=?,next_run_reason=? WHERE id=?',
      status,
      scheduledStatus(status) ? new Date(now).toISOString() : null,
      reason,
      id,
    );
    return this.find(id)!;
  }
  private run(row: Row): PursuitRun {
    return {
      id: String(row.id),
      pursuitId: String(row.pursuit_id),
      conversationId: String(row.conversation_id),
      status: row.status as PursuitRun['status'],
      trigger: row.trigger as PursuitRun['trigger'],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at as string | null,
      summary: String(row.summary),
      error: row.error as string | null,
      snapshot: JSON.parse(String(row.snapshot_json)) as Pursuit,
    };
  }
  runs(id: string) {
    return this.database
      .all(
        'SELECT * FROM pursuit_runs WHERE pursuit_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100',
        id,
      )
      .map((row) => this.run(row));
  }
  findRun(id: string) {
    const row = this.database.get('SELECT * FROM pursuit_runs WHERE id=?', id);
    return row ? this.run(row) : undefined;
  }
  isRunConversation(id: string) {
    return Boolean(this.database.get('SELECT id FROM pursuit_runs WHERE conversation_id=?', id));
  }
  due(now: number) {
    const date = new Date(now).toISOString();
    return this.database
      .all(
        "SELECT id FROM pursuits WHERE status IN ('active','waiting') AND (next_run_at<=? OR deadline<=?) ORDER BY next_run_at LIMIT 100",
        date,
        date,
      )
      .map((row) => String(row.id));
  }
  claim(id: string, trigger: PursuitRun['trigger'], now: number) {
    return this.database.transaction(() => {
      const pursuit = this.find(id);
      if (!pursuit || !scheduledStatus(pursuit.status) || pursuit.currentRunId) return null;
      if (pursuit.deadline && Date.parse(pursuit.deadline) <= now) {
        this.setStatus(
          id,
          'blocked',
          'Deadline reached. Review the objective or extend the deadline.',
          now,
        );
        return null;
      }
      if (trigger === 'schedule' && (!pursuit.nextRunAt || Date.parse(pursuit.nextRunAt) > now))
        return null;
      const runId = randomUUID(),
        conversationId = randomUUID(),
        date = new Date(now).toISOString();
      this.database.run(
        "INSERT INTO conversations(id,workspace_id,kind,name,description,created_at,updated_at) VALUES(?,?,'pursuit_run',?,?,?,?)",
        conversationId,
        pursuit.workspaceId,
        pursuit.name,
        pursuit.objective,
        date,
        date,
      );
      if (pursuit.ownerBotId)
        this.database.run(
          'INSERT INTO conversation_bots VALUES(?,?)',
          conversationId,
          pursuit.ownerBotId,
        );
      this.database.run(
        "INSERT INTO pursuit_runs(id,pursuit_id,conversation_id,status,trigger,started_at,snapshot_json) VALUES(?,?,?,'running',?,?,?)",
        runId,
        id,
        conversationId,
        trigger,
        date,
        JSON.stringify(pursuit),
      );
      this.database.run('UPDATE pursuits SET next_run_at=NULL WHERE id=?', id);
      return this.findRun(runId)!;
    });
  }
  finish(
    runId: string,
    status: Exclude<PursuitRun['status'], 'running'>,
    summary: string,
    error: string | null,
    outcome: PursuitStatus,
    now: number,
    report?: PursuitReport,
  ) {
    this.database.transaction(() => {
      const run = this.findRun(runId)!;
      this.database.run(
        'UPDATE pursuit_runs SET status=?,summary=?,error=?,finished_at=? WHERE id=?',
        status,
        summary,
        error,
        new Date(now).toISOString(),
        runId,
      );
      const pursuit = this.find(run.pursuitId)!;
      if (pursuit.status === 'paused' || pursuit.status === 'completed') return;
      const deadlinePassed = pursuit.deadline && Date.parse(pursuit.deadline) <= now;
      const scheduleProblem = scheduledStatus(outcome)
        ? status !== 'complete'
          ? 'The run did not finish successfully. Review its saved work before resuming.'
          : pursuitReportProblem(report, now, pursuit.deadline)
        : undefined;
      const nextStatus =
        deadlinePassed && outcome !== 'completed'
          ? 'blocked'
          : scheduleProblem
            ? 'waiting_for_you'
            : outcome;
      this.database.run(
        'UPDATE pursuits SET status=?,next_run_at=?,next_run_reason=?,next_run_instructions=? WHERE id=?',
        nextStatus,
        scheduledStatus(nextStatus) ? report?.nextRunAt || null : null,
        error ||
          scheduleProblem ||
          (deadlinePassed && nextStatus !== 'completed'
            ? 'Deadline reached. Review this pursuit.'
            : scheduledStatus(nextStatus)
              ? report?.nextRunReason || 'Next pursuit run'
              : summary),
        scheduledStatus(nextStatus)
          ? report?.nextRunInstructions || ''
          : pursuit.nextRunInstructions,
        pursuit.id,
      );
    });
  }
  recover(now: number) {
    this.database.transaction(() => {
      const interrupted = this.database.all(
        "SELECT pursuit_id FROM pursuit_runs WHERE status='running' AND conversation_id NOT IN (SELECT m.conversation_id FROM pending_tool_approvals a JOIN messages m ON m.id=a.message_id)",
      );
      this.database.run(
        "UPDATE pursuit_runs SET status='interrupted',finished_at=?,error='Server restarted during this run. Review its saved work before resuming.' WHERE status='running' AND conversation_id NOT IN (SELECT m.conversation_id FROM pending_tool_approvals a JOIN messages m ON m.id=a.message_id)",
        new Date(now).toISOString(),
      );
      for (const row of interrupted) {
        const status = this.find(String(row.pursuit_id))?.status;
        if (status === 'paused' || status === 'completed') continue;
        this.setStatus(
          String(row.pursuit_id),
          'waiting_for_you',
          'Interrupted run needs review before resuming.',
          now,
        );
      }
    });
  }
  pendingRuns() {
    return this.database
      .all(
        "SELECT id FROM pursuit_runs WHERE status='running' AND conversation_id IN (SELECT m.conversation_id FROM pending_tool_approvals a JOIN messages m ON m.id=a.message_id)",
      )
      .map((row) => this.findRun(String(row.id))!);
  }
}
