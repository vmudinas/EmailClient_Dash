import { describe, expect, it } from "vitest";
import { MboxMessageCounter } from "./archive-fingerprint.js";

describe("MboxMessageCounter", () => {
  it("counts envelope lines when the marker is split across chunks", () => {
    const counter = new MboxMessageCounter();
    counter.add(Buffer.from("From sender@example.test Mon Jul 13 00:00:00 2026\nSubject: One\n\nBody\nF"));
    counter.add(Buffer.from("rom sender@example.test Mon Jul 13 00:01:00 2026\nSubject: Two\n\n>From quoted body\n"));

    expect(counter.count).toBe(2);
  });

  it("does not count From text that is not at the start of a line", () => {
    const counter = new MboxMessageCounter();
    counter.add(Buffer.from("Header: From sender@example.test\nplain From body\n"));

    expect(counter.count).toBe(0);
  });
});
