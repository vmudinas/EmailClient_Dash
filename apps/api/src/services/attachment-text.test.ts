import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentTextExtractor } from "./attachment-text.js";

const extractors: AttachmentTextExtractor[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(extractors.splice(0).map((extractor) => extractor.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("AttachmentTextExtractor", () => {
  it("indexes plain text and leaves unsupported binary files searchable by filename", async () => {
    const extractor = new AttachmentTextExtractor();
    extractors.push(extractor);
    const signal = new AbortController().signal;

    await expect(extractor.extract(
      "notes.txt",
      "text/plain",
      Buffer.from("Release checklist\nSigned installer"),
      false,
      signal
    )).resolves.toEqual({
      text: "Release checklist\nSigned installer",
      status: "indexed"
    });

    await expect(extractor.extract(
      "archive.bin",
      "application/octet-stream",
      Buffer.from([0, 1, 2]),
      false,
      signal
    )).resolves.toEqual({ text: "", status: "unsupported" });
  });

  it("does not send GIF tracking images to OCR", async () => {
    const extractor = new AttachmentTextExtractor();
    extractors.push(extractor);

    await expect(extractor.extract(
      "tracking.gif",
      "image/gif",
      Buffer.from("GIF89a"),
      true,
      new AbortController().signal
    )).resolves.toEqual({ text: "", status: "unsupported" });
  });

  it("contains a crashing extraction worker without terminating the API process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "email-client-worker-test-"));
    temporaryDirectories.push(directory);
    const workerPath = join(directory, "crashing-worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort.on("message", () => {',
      '  throw new Error("intentional extraction worker crash");',
      '});'
    ].join("\n"));

    const extractor = new AttachmentTextExtractor({
      workerUrl: pathToFileURL(workerPath),
      workerExecArgv: []
    });
    extractors.push(extractor);

    await expect(extractor.extract(
      "scan.png",
      "image/png",
      Buffer.from([0, 1, 2]),
      true,
      new AbortController().signal
    )).rejects.toThrow("intentional extraction worker crash");

    await expect(extractor.extract(
      "after-crash.txt",
      "text/plain",
      Buffer.from("API still running"),
      false,
      new AbortController().signal
    )).resolves.toEqual({ text: "API still running", status: "indexed" });
  });

  it("terminates a hung extraction worker after the per-item deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "email-client-worker-timeout-"));
    temporaryDirectories.push(directory);
    const workerPath = join(directory, "silent-worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort.on("message", () => undefined);'
    ].join("\n"));

    const extractor = new AttachmentTextExtractor({
      workerUrl: pathToFileURL(workerPath),
      workerExecArgv: [],
      workerTimeoutMs: 20
    });
    extractors.push(extractor);

    await expect(extractor.extract(
      "stalled.pdf",
      "application/pdf",
      Buffer.from([0, 1, 2]),
      true,
      new AbortController().signal
    )).rejects.toThrow("Attachment text extraction timed out after 1 seconds");
  });
});
