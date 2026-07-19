import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import type { SmartMailRuleRunScope } from "@email-client/shared";
import type { SmartMailRuleRunChunkResult } from "../storage/database.js";

interface MailboxTaskWorkerData {
  databasePath: string;
  ruleIds: string[];
  scope: SmartMailRuleRunScope;
  plannedCounts: number[];
  chunkSize: number;
}

const input = workerData as MailboxTaskWorkerData;
let cancelRequested = false;

parentPort?.on("message", (message: { type?: string }) => {
  if (message.type === "cancel") cancelRequested = true;
});

void run();

async function run(): Promise<void> {
  const runningTypeScript = import.meta.url.endsWith(".ts");
  const [{ EmailDatabase }, { yieldToEventLoop }] = await Promise.all([
    import(runningTypeScript ? "../storage/database.ts" : "../storage/database.js"),
    import(runningTypeScript ? "./yield-to-event-loop.ts" : "./yield-to-event-loop.js")
  ]);
  const database = new EmailDatabase(dirname(input.databasePath), input.databasePath, {
    migrate: false,
    recoverInterruptedJobs: false
  });
  let totalMessages = input.plannedCounts.reduce((total, count) => total + count, 0);
  let completedRules = 0;
  let processedMessages = 0;
  let matchedMessages = 0;
  let movedMessages = 0;
  let markedReadMessages = 0;
  let starredMessages = 0;
  let terminalMessage: Record<string, unknown>;
  try {
    for (const [ruleIndex, ruleId] of input.ruleIds.entries()) {
      if (cancelRequested) break;
      const rule = database.getSmartMailRule(ruleId);
      if (!rule) throw new Error("Mail rule no longer exists");
      if (!rule.enabled) throw new Error(`Mail rule "${rule.name}" was paused before it ran`);
      const actualCount = database.countSmartMailRuleCandidates(rule.id, input.scope);
      totalMessages += actualCount - (input.plannedCounts[ruleIndex] ?? 0);
      parentPort?.postMessage({
        type: "progress",
        patch: { totalMessages, currentRuleId: rule.id, currentRuleName: rule.name }
      });
      let cursor: string | null = null;
      let done = false;
      while (!done && !cancelRequested) {
        const chunk: SmartMailRuleRunChunkResult = database.runSmartMailRuleChunk(
          rule.id,
          input.scope,
          cursor,
          input.chunkSize
        );
        cursor = chunk.nextCursor;
        done = chunk.done;
        processedMessages += chunk.scannedMessages;
        matchedMessages += chunk.matchedMessages;
        movedMessages += chunk.movedMessages;
        markedReadMessages += chunk.markedReadMessages;
        starredMessages += chunk.starredMessages;
        parentPort?.postMessage({
          type: "progress",
          patch: {
            totalMessages,
            completedRules,
            processedMessages,
            matchedMessages,
            movedMessages,
            markedReadMessages,
            starredMessages
          }
        });
        await yieldToEventLoop();
      }
      if (!cancelRequested) completedRules += 1;
    }
    if (movedMessages > 0) {
      const firstRule = input.ruleIds[0] ? database.getSmartMailRule(input.ruleIds[0]) : null;
      if (firstRule) database.refreshArchiveFolderMessageCounts(firstRule.archiveId);
    }
    terminalMessage = {
      type: "finished",
      status: cancelRequested ? "cancelled" : "completed",
      patch: {
        totalMessages: cancelRequested ? totalMessages : processedMessages,
        completedRules,
        currentRuleId: null,
        currentRuleName: null,
        processedMessages,
        matchedMessages,
        movedMessages,
        markedReadMessages,
        starredMessages
      }
    };
  } catch (error) {
    terminalMessage = {
      type: "failed",
      error: error instanceof Error ? error.message : "Smart mail rule task failed",
      stack: error instanceof Error ? error.stack ?? null : null,
      patch: {
        totalMessages,
        completedRules,
        currentRuleId: null,
        currentRuleName: null,
        processedMessages,
        matchedMessages,
        movedMessages,
        markedReadMessages,
        starredMessages
      }
    };
  } finally {
    database.close();
  }
  parentPort?.postMessage(terminalMessage);
  parentPort?.close();
}
