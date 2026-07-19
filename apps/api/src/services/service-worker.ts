import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export function createServiceWorker(
  parentUrl: string,
  sourcePath: string,
  builtPath: string,
  workerData: unknown
): Worker {
  if (!parentUrl.endsWith(".ts")) {
    return new Worker(new URL(builtPath, parentUrl), { workerData });
  }
  const require = createRequire(parentUrl);
  const tsxApiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const workerUrl = new URL(sourcePath, parentUrl).href;
  const bootstrap = `
    import(${JSON.stringify(tsxApiUrl)})
      .then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl)}, ${JSON.stringify(parentUrl)}))
      .catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Worker(bootstrap, { eval: true, workerData });
}
