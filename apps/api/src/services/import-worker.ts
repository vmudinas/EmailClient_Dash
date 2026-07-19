import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { ImportService as ImportServiceType } from "./import-service.js";

interface ImportWorkerData {
  databasePath: string;
  blobDataDir: string;
  jobId: string;
}

const input = workerData as ImportWorkerData;
let service: ImportServiceType | null = null;
let cancelRequested = false;

parentPort?.on("message", (message: { type?: string }) => {
  if (message.type !== "cancel") return;
  cancelRequested = true;
  service?.abortJob(input.jobId);
});

void run();

async function run(): Promise<void> {
  const runningTypeScript = import.meta.url.endsWith(".ts");
  const [{ BlobStore }, { EmailDatabase }, { ImportService }] = await Promise.all([
    import(runningTypeScript ? "../storage/blob-store.ts" : "../storage/blob-store.js"),
    import(runningTypeScript ? "../storage/database.ts" : "../storage/database.js"),
    import(runningTypeScript ? "./import-service.ts" : "./import-service.js")
  ]);
  const database = new EmailDatabase(dirname(input.databasePath), input.databasePath, {
    migrate: false,
    recoverInterruptedJobs: false
  });
  const blobs = new BlobStore(input.blobDataDir);
  const importService = new ImportService(database, blobs, { useWorker: false });
  service = importService;
  let failure: { error: string; stack: string | null } | null = null;
  try {
    await importService.initialize();
    if (cancelRequested) {
      database.updateImportJob(input.jobId, {
        status: "cancelled",
        canResume: true,
        message: "Import cancelled"
      });
    } else {
      await importService.runJobInCurrentThread(input.jobId);
    }
  } catch (error) {
    failure = {
      error: error instanceof Error ? error.message : "Import worker failed",
      stack: error instanceof Error ? error.stack ?? null : null
    };
  } finally {
    await importService.close();
    database.close();
  }
  parentPort?.postMessage(failure ? { type: "failed", ...failure } : { type: "finished" });
  parentPort?.close();
}
