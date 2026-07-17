import { extname } from "node:path";
import { parentPort } from "node:worker_threads";
import { OfficeParser } from "officeparser";
import { createWorker, type Worker as TesseractWorker } from "tesseract.js";

interface ExtractionRequest {
  id: string;
  filename: string;
  contentType: string;
  content: Uint8Array;
  ocrEnabled: boolean;
}

const port = parentPort;
if (!port) throw new Error("Attachment text worker requires a parent port");

let queue = Promise.resolve();
let ocrWorkerPromise: Promise<TesseractWorker> | null = null;

port.on("message", (request: ExtractionRequest) => {
  queue = queue.then(() => handleRequest(request));
});

async function handleRequest(request: ExtractionRequest): Promise<void> {
  try {
    const result = await extract(
      request.filename,
      request.contentType,
      Buffer.from(request.content),
      request.ocrEnabled
    );
    port!.postMessage({ id: request.id, result });
  } catch (error) {
    port!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
  }
}

async function extract(
  filename: string,
  contentType: string,
  content: Buffer,
  ocrEnabled: boolean
): Promise<{ text: string; status: "indexed" | "ocr_indexed" }> {
  const extension = extname(filename).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg"
    || extension === ".tif" || extension === ".tiff" || extension === ".bmp"
    || extension === ".webp" || contentType.startsWith("image/")) {
    const worker = await getOcrWorker();
    try {
      const result = await worker.recognize(content);
      return { text: normalizeExtractedText(result.data.text), status: "ocr_indexed" };
    } catch (error) {
      ocrWorkerPromise = null;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  const fileType = extension === ".htm" ? "html" : extension.slice(1);
  const ast = await OfficeParser.parseOffice(content, {
    fileType: fileType as never,
    extractAttachments: ocrEnabled,
    ocr: ocrEnabled,
    ocrConfig: { language: "eng" }
  });
  return {
    text: normalizeExtractedText(ast.toText()),
    status: ocrEnabled ? "ocr_indexed" : "indexed"
  };
}

function getOcrWorker(): Promise<TesseractWorker> {
  ocrWorkerPromise ??= createWorker("eng", undefined, {
    logger: () => undefined,
    errorHandler: () => undefined
  }).catch((error) => {
    ocrWorkerPromise = null;
    throw error;
  });
  return ocrWorkerPromise;
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
}
