import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import type {
  SmartMailRuleBatchRun,
  SmartMailRuleRunTask
} from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import { createServiceWorker } from "./service-worker.js";

const SMART_RULE_CHUNK_SIZE = 500;
const MAX_RETAINED_TASKS = 100;

export class MailboxTaskService {
  private readonly tasks = new Map<string, SmartMailRuleRunTask>();
  private readonly queue: string[] = [];
  private readonly plannedRuleCounts = new Map<string, number[]>();
  private readonly workers = new Map<string, Worker>();
  private run: Promise<void> | null = null;
  private scheduled = false;
  private closing = false;

  constructor(private readonly database: EmailStore) {}

  enqueueSmartRuleRun(input: SmartMailRuleBatchRun): SmartMailRuleRunTask {
    if (this.closing) throw new Error("Mailbox task worker is shutting down");
    const ruleIds = [...new Set(input.ruleIds)];
    const rules = ruleIds.map((ruleId) => {
      const rule = this.database.getSmartMailRule(ruleId);
      if (!rule) throw new Error("Mail rule not found");
      if (rule.archiveId !== input.archiveId) throw new Error("Every mail rule must belong to the selected archive");
      if (!rule.enabled) throw new Error(`Enable the mail rule "${rule.name}" before running it`);
      return rule;
    });
    const plannedCounts = rules.map((rule) => this.database.countSmartMailRuleCandidates(rule.id, input.scope));
    const now = new Date().toISOString();
    const task: SmartMailRuleRunTask = {
      id: randomUUID(),
      type: "smart_rule_run",
      status: "queued",
      archiveId: input.archiveId,
      scope: input.scope,
      ruleIds,
      totalRules: rules.length,
      completedRules: 0,
      currentRuleId: null,
      currentRuleName: null,
      totalMessages: plannedCounts.reduce((total, count) => total + count, 0),
      processedMessages: 0,
      matchedMessages: 0,
      movedMessages: 0,
      markedReadMessages: 0,
      starredMessages: 0,
      cancelRequested: false,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null
    };
    this.tasks.set(task.id, task);
    this.plannedRuleCounts.set(task.id, plannedCounts);
    this.queue.push(task.id);
    this.pruneTasks();
    this.scheduleWork();
    this.database.recordDiagnostic({
      level: "info",
      category: "system",
      message: `Queued ${rules.length} smart mail rule${rules.length === 1 ? "" : "s"}`,
      archiveId: input.archiveId,
      context: { operation: "smart_rule_task_queue", taskId: task.id, scope: task.scope, ruleIds }
    });
    return cloneTask(task);
  }

  getTask(id: string): SmartMailRuleRunTask | null {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : null;
  }

  cancelTask(id: string): SmartMailRuleRunTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Mailbox task not found");
    if (["completed", "failed", "cancelled"].includes(task.status)) return cloneTask(task);
    task.cancelRequested = true;
    this.workers.get(id)?.postMessage({ type: "cancel" });
    if (task.status === "queued") {
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
    }
    return cloneTask(task);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const task of this.tasks.values()) {
      if (task.status === "queued") {
        task.status = "cancelled";
        task.cancelRequested = true;
        task.completedAt = new Date().toISOString();
      } else if (task.status === "running") {
        task.cancelRequested = true;
        this.workers.get(task.id)?.postMessage({ type: "cancel" });
      }
    }
    if (this.run) await this.run;
  }

  private scheduleWork(): void {
    if (this.run || this.scheduled || this.closing) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closing || this.run) return;
      const run = this.processQueue();
      this.run = run;
      void run.finally(() => {
        if (this.run === run) this.run = null;
        if (this.queue.length > 0) this.scheduleWork();
      }).catch(() => undefined);
    });
  }

  private async processQueue(): Promise<void> {
    while (!this.closing) {
      const taskId = this.queue.shift();
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "queued") continue;
      await this.processSmartRuleTask(task);
    }
  }

  private async processSmartRuleTask(task: SmartMailRuleRunTask): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    const plannedCounts = this.plannedRuleCounts.get(task.id) ?? [];
    const worker = createServiceWorker(import.meta.url, "./mailbox-task-worker.ts", "./mailbox-task-worker.js", {
      databasePath: this.database.path,
      ruleIds: task.ruleIds,
      scope: task.scope,
      plannedCounts,
      chunkSize: SMART_RULE_CHUNK_SIZE
    });
    this.workers.set(task.id, worker);
    try {
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        worker.on("message", (message: {
          type: "progress" | "finished" | "failed";
          status?: "completed" | "cancelled";
          patch?: Partial<SmartMailRuleRunTask>;
          error?: string;
          stack?: string | null;
        }) => {
          if (message.patch) Object.assign(task, message.patch);
          if (message.type === "progress") return;
          task.status = message.type === "failed" ? "failed" : message.status ?? "completed";
          task.error = message.type === "failed" ? message.error ?? "Smart mail rule task failed" : null;
          task.completedAt = new Date().toISOString();
          this.database.recordDiagnostic({
            level: task.status === "completed" ? "info" : task.status === "failed" ? "error" : "warning",
            category: "system",
            message: task.status === "completed"
              ? "Smart mail rule task completed"
              : task.status === "failed" ? task.error ?? "Smart mail rule task failed" : "Smart mail rule task cancelled",
            stack: message.stack ?? null,
            archiveId: task.archiveId,
            context: taskContext(task)
          });
        });
        worker.on("error", (error) => {
          task.status = "failed";
          task.error = error.message;
          task.completedAt = new Date().toISOString();
          finish();
        });
        worker.on("exit", (code) => {
          if (code !== 0) {
            task.status = "failed";
            task.error = `Smart mail rule worker stopped unexpectedly (${code})`;
            task.completedAt = new Date().toISOString();
          }
          finish();
        });
        if (task.cancelRequested || this.closing) worker.postMessage({ type: "cancel" });
      });
    } finally {
      this.workers.delete(task.id);
      this.plannedRuleCounts.delete(task.id);
      await worker.terminate();
    }
  }

  private pruneTasks(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    const finished = [...this.tasks.values()]
      .filter((task) => ["completed", "failed", "cancelled"].includes(task.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (this.tasks.size > MAX_RETAINED_TASKS && finished.length > 0) {
      const task = finished.shift()!;
      this.tasks.delete(task.id);
      this.plannedRuleCounts.delete(task.id);
    }
  }
}

function cloneTask(task: SmartMailRuleRunTask): SmartMailRuleRunTask {
  return { ...task, ruleIds: [...task.ruleIds] };
}

function taskContext(task: SmartMailRuleRunTask): Record<string, unknown> {
  return {
    operation: "smart_rule_task",
    taskId: task.id,
    scope: task.scope,
    totalRules: task.totalRules,
    completedRules: task.completedRules,
    processedMessages: task.processedMessages,
    matchedMessages: task.matchedMessages,
    movedMessages: task.movedMessages,
    markedReadMessages: task.markedReadMessages,
    starredMessages: task.starredMessages
  };
}
