import type { AiSchedule } from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import { AiConfigurationError, type AiService } from "./ai-service.js";

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
    await this.runSchedule(schedule, new Date().toISOString());
    return this.database.getAiSchedule(scheduleId)!;
  }

  private async runSchedule(schedule: AiSchedule, now: string): Promise<void> {
    try {
      const messageIds = schedule.messageId
        ? [schedule.messageId]
        : this.database.listMessageIdsForSchedule(schedule.folderId, schedule.mode);
      let queued = 0;
      for (const messageId of messageIds) {
        try {
          const agent = {
            provider: schedule.provider,
            model: schedule.model,
            skills: schedule.skills,
            prompt: schedule.prompt
          };
          const result = schedule.task === "draft_reply"
            ? this.ai.startDraftReply(messageId, {
                scheduleId: schedule.id,
                gmailConnectionId: schedule.gmailConnectionId!,
                resumeId: schedule.resumeId,
                agent
              })
            : this.ai.startAnalysis(messageId, agent);
          if (result.job.status === "queued") queued += 1;
        } catch (error) {
          if (error instanceof AiConfigurationError) {
            this.finishRun(schedule, now, `Skipped: ${error.message}`, "warning");
            return;
          }
          // Any other per-message failure (e.g. message deleted mid-run) shouldn't abort the rest of the sweep.
        }
      }
      this.finishRun(
        schedule,
        now,
        schedule.task === "draft_reply"
          ? `Queued ${queued} of ${messageIds.length} email${messageIds.length === 1 ? "" : "s"} for draft review`
          : `Queued ${queued} of ${messageIds.length} message${messageIds.length === 1 ? "" : "s"}`,
        "info"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI schedule run failed";
      this.finishRun(schedule, now, `Failed: ${message}`, "error", error instanceof Error ? error.stack : null);
    }
  }

  private finishRun(
    schedule: AiSchedule,
    now: string,
    summary: string,
    level: "info" | "warning" | "error",
    stack: string | null = null
  ): void {
    this.database.recordAiScheduleRun(schedule.id, now, summary);
    this.database.recordDiagnostic({
      level,
      category: "ai",
      message: `AI schedule "${schedule.name}": ${summary}`,
      stack,
      context: {
        operation: "schedule_run",
        scheduleId: schedule.id,
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
