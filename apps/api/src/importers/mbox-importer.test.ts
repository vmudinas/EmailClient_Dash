import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importMboxFile } from "./mbox-importer.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("importMboxFile", () => {
  it("cancels through the stream pipeline without emitting an unhandled file error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archive-mail-mbox-cancel-"));
    directories.push(directory);
    const sourcePath = join(directory, "cancel.mbox");
    await writeFile(sourcePath, mboxFixture());
    const controller = new AbortController();
    let processedMessages = 0;
    let itemErrors = 0;

    const importPromise = importMboxFile(sourcePath, {
      signal: controller.signal,
      sourceName: "cancel.mbox",
      startAfterMessage: 0,
      totalItems: 2,
      onMessage: async () => {
        processedMessages += 1;
        controller.abort();
      },
      onTotal: () => undefined,
      onProgress: () => undefined,
      onError: () => { itemErrors += 1; }
    });

    await expect(importPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(processedMessages).toBe(1);
    expect(itemErrors).toBe(0);
  });
});

function mboxFixture(): string {
  return [
    "From sender@example.test Mon Jul 13 00:00:00 2026",
    "From: sender@example.test",
    "To: receiver@example.test",
    "Subject: First",
    "Message-ID: <first@example.test>",
    "",
    "First body",
    "From sender@example.test Mon Jul 13 00:01:00 2026",
    "From: sender@example.test",
    "To: receiver@example.test",
    "Subject: Second",
    "Message-ID: <second@example.test>",
    "",
    "Second body",
    ""
  ].join("\n");
}
