import { describe, expect, it } from "vitest";
import { displayAddress, formatBytes, initials } from "./format.js";

describe("format helpers", () => {
  it("formats file sizes and sender labels", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(displayAddress({ name: "Maya Chen", address: "maya@example.test" })).toBe("Maya Chen");
    expect(initials({ name: "Maya Chen", address: "maya@example.test" })).toBe("MC");
  });
});

