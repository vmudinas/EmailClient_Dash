import type { AiJob, AiSchedule } from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import { AiConfigurationError, AiDraftSkippedError, type AiService } from "./ai-service.js";

const TICK_INTERVAL_MS = 60_000;

// Runs configured AI schedules on a shared tick rather than one setInterval per schedule,
// so editing/adding/removing schedules never needs to re-derive timer drift.
export class AiScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly database: EmailStore,
    private readonly ai: AiService
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runDueSchedules(); }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runDueSchedules(now: string = new Date().toISOString()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const schedule of this.database.dueAiSchedules(now)) {
        await this.runSchedule(schedule, now);
      }
    } finally {
      this.running = false;
    }
  }

  /** Runs one schedule immediately, regardless of whether its interval has elapsed. */
  async runNow(scheduleId: string): Promise<AiSchedule> {
    const schedule = this.database.getAiSchedule(scheduleId);
    if (!schedule) throw new Error("Schedule not found");
    if (schedule.progress && ["queueing", "processing"].includes(schedule.progress.status)) {
      throw new Error("Schedule already has a run in progress");
    }
    await this.runSchedule(schedule, new Date().toISOString());
    return this.database.getAiSchedule(scheduleId)!;
  }

  private async runSchedule(schedule: AiSchedule, now: string): Promise<void> {
    let runId: string | null = null;
    try {
      const messageIds = schedule.messageId
        ? [schedule.messageId]
        : this.database.listMessageIdsForSchedule(schedule.folderId, schedule.mode);
      runId = this.database.createAiScheduleRun(schedule.id, messageIds.length, now);
      let queued = 0;
      let skipped = 0;
      let enqueueErrors = 0;
      for (const messageId of messageIds) {
        try {
          const agent = {
            provider: schedule.provider,
            model: schedule.model,
            skills: schedule.skills,
            prompt: schedule.prompt
          };
          const job: AiJob = schedule.task === "draft_reply"
            ? this.ai.startDraftReply(messageId, {
                scheduleId: schedule.id,
                scheduleRunId: runId,
                gmailConnectionId: schedule.gmailConnectionId!,
                resumeId: schedule.resumeId,
                agent
              }).job
            : this.ai.startAnalysis(messageId, agent, {
                scheduleId: schedule.id,
                scheduleRunId: runId
              }).job;
          if (job.scheduleRunId === runId) queued += 1;
          else skipped += 1;
        } catch (error) {
          if (error instanceof AiDraftSkippedError) {
            skipped += 1;
            this.database.recordDiagnostic({
              level: "info",
              category: "ai",
              message: `AI draft skipped: ${error.message}`,
              archiveId: schedule.archiveId,
              context: {
                operation: "draft_skip",
                scheduleId: schedule.id,
                scheduleRunId: runId,
                messageId,
                reason: error.message
              }
            });
            continue;
          }
          if (error instanceof AiConfigurationError) {
            const progress = this.database.failAiScheduleRun(runId, error.message);
            this.recordRunDiagnostic(schedule, progress.error ? `Failed: ${progress.error}` : "Failed", "warning", null, runId);
            return;
          }
          enqueueErrors += 1;
        }
      }
      const progress = this.database.finishAiScheduleEnqueue(runId, {
        queuedJobs: queued,
        skippedMessages: skipped,
        enqueueErrors
      });
      this.recordRunDiagnostic(
        schedule,
        this.database.getAiSchedule(schedule.id)?.lastRunSummary ?? `Started ${queued} jobs`,
        progress.status === "completed_with_errors" ? "warning" : "info",
        null,
        runId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI schedule run failed";
      if (runId) this.database.failAiScheduleRun(runId, message);
      else this.database.recordAiScheduleRun(schedule.id, now, `Failed: ${message}`);
      this.recordRunDiagnostic(schedule, `Failed: ${message}`, "error", error instanceof Error ? error.stack ?? null : null, runId);
    }
  }

  private recordRunDiagnostic(
    schedule: AiSchedule,
    summary: string,
    level: "info" | "warning" | "error",
    stack: string | null,
    runId: string | null
  ): void {
    this.database.recordDiagnostic({
      level,
      category: "ai",
      message: `AI schedule "${schedule.name}": ${summary}`,
      stack,
      context: {
        operation: "schedule_run",
        scheduleId: schedule.id,
        scheduleRunId: runId,
        task: schedule.task,
        folderId: schedule.folderId,
        messageId: schedule.messageId,
        gmailConnectionId: schedule.gmailConnectionId,
        resumeId: schedule.resumeId,
        mode: schedule.mode,
        provider: schedule.provider,
        model: schedule.model,
        skills: schedule.skills
      }
    });
  }
}
