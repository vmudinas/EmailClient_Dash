import type { ImportJob } from "@email-client/shared";
import { formatBytes } from "./format.js";

export interface ImportEtaSample {
  phase: ImportJob["phase"];
  processedItems: number;
  totalItems: number | null;
  sampledAt: number;
  itemsPerSecond: number | null;
}

export interface ImportEtaUpdate {
  sample: ImportEtaSample;
  secondsRemaining: number | null;
}

/**
 * A combine has no file to read, count or parse - it moves rows it counted up front. So its
 * progress is the plain ratio the import phases have to approximate around, and its labels say
 * moving rather than importing.
 */
function isCombine(job: ImportJob): boolean {
  return job.sourceType === "combine";
}

export function importProgressPercent(job: ImportJob): number {
  if (job.status === "completed" || job.status === "completed_with_errors") return 100;
  if (job.phase === "queued") return 0;
  if (isCombine(job)) {
    if (job.totalItems === null) return 0;
    if (job.totalItems === 0) return 99;
    return Math.min(99, Math.round(ratio(job.processedItems, job.totalItems) * 100));
  }
  if (job.phase === "fingerprinting") {
    return Math.round(ratio(job.processedBytes, job.totalBytes) * 10);
  }
  if (job.phase === "parsing") {
    if (job.totalItems === null) {
      return job.sourceType === "mbox"
        ? Math.min(99, 10 + Math.round(ratio(job.processedBytes, job.totalBytes) * 89))
        : 10;
    }
    if (job.totalItems === 0) return 99;
    return Math.min(99, 10 + Math.round(ratio(job.processedItems, job.totalItems) * 89));
  }
  if (job.phase === "attachments") return 96;
  if (job.phase === "indexing") return 98;
  return 99;
}

export function importPhaseLabel(job: ImportJob): string {
  if (isCombine(job)) {
    if (job.status === "cancelled") return "Combine stopped";
    if (job.status === "failed") return "Combine failed";
    if (job.status === "completed" || job.status === "completed_with_errors") return "Combine complete";
    if (job.status === "queued") return "Waiting to combine";
    return "Moving emails";
  }
  if (job.status === "paused") return "Import paused";
  if (job.status === "cancelled") return "Import stopped";
  if (job.status === "failed") return "Import failed";
  if (job.status === "completed_with_errors") return "Completed with issues";
  if (job.status === "completed") return "Import complete";
  if (job.status === "queued") return "Waiting to start";
  if (job.phase === "fingerprinting") {
    return job.processedBytes > 0 ? "Extracting messages" : "Scanning and counting";
  }
  if (job.phase === "parsing") {
    return job.totalItems === null ? "Counting emails" : "Importing emails";
  }
  if (job.phase === "attachments") return "Reading attachments";
  if (job.phase === "indexing") return "Updating search index";
  return "Finalizing import";
}

export function importEmailCountLabel(job: ImportJob): string {
  if (job.totalItems !== null) {
    return `${job.processedItems.toLocaleString()} of ${job.totalItems.toLocaleString()} emails`;
  }
  if (job.phase === "fingerprinting") {
    if (job.totalBytes > 0 && job.processedBytes > 0) {
      return `${formatBytes(job.processedBytes)} of ${formatBytes(job.totalBytes)} read`;
    }
    return "Counting total emails";
  }
  return `${job.processedItems.toLocaleString()} emails processed`;
}

export function updateImportEta(
  previous: ImportEtaSample | undefined,
  job: ImportJob
): ImportEtaUpdate {
  const sampledAt = Date.parse(job.updatedAt);
  let itemsPerSecond = previous?.itemsPerSecond ?? null;
  const canMeasure = job.status === "running"
    && job.phase === "parsing"
    && job.totalItems !== null
    && Number.isFinite(sampledAt);

  if (!canMeasure) {
    return {
      sample: sampleFromJob(job, sampledAt, null),
      secondsRemaining: null
    };
  }

  if (
    previous
    && previous.phase === job.phase
    && previous.totalItems === job.totalItems
    && sampledAt > previous.sampledAt
    && job.processedItems > previous.processedItems
  ) {
    const elapsedSeconds = (sampledAt - previous.sampledAt) / 1_000;
    const observedRate = (job.processedItems - previous.processedItems) / elapsedSeconds;
    itemsPerSecond = previous.itemsPerSecond === null
      ? observedRate
      : previous.itemsPerSecond * 0.7 + observedRate * 0.3;
  }

  const remaining = Math.max(0, job.totalItems! - job.processedItems);
  return {
    sample: sampleFromJob(job, sampledAt, itemsPerSecond),
    secondsRemaining: itemsPerSecond && itemsPerSecond > 0
      ? remaining / itemsPerSecond
      : null
  };
}

export function formatImportEta(secondsRemaining: number | null, now = Date.now()): string {
  if (secondsRemaining === null || !Number.isFinite(secondsRemaining)) {
    return "Estimating completion time";
  }
  if (secondsRemaining <= 0) return "Finishing now";

  const duration = secondsRemaining < 60
    ? "less than 1 min"
    : secondsRemaining < 3_600
      ? `${Math.ceil(secondsRemaining / 60)} min`
      : `${Math.floor(secondsRemaining / 3_600)} hr ${Math.ceil((secondsRemaining % 3_600) / 60)} min`;
  const completion = new Date(now + secondsRemaining * 1_000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
  return `About ${duration} left · done around ${completion}`;
}

function sampleFromJob(
  job: ImportJob,
  sampledAt: number,
  itemsPerSecond: number | null
): ImportEtaSample {
  return {
    phase: job.phase,
    processedItems: job.processedItems,
    totalItems: job.totalItems,
    sampledAt,
    itemsPerSecond
  };
}

function ratio(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, value / total));
}
