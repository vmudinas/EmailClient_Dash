import { startServer } from "./app.js";

const started = await startServer();
started.runtime.app.log.info(`Archive Mail API listening at ${started.url}`);

const shutdown = async () => {
  await started.runtime.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

