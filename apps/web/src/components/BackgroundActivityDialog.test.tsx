import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackgroundActivityDialog } from "./BackgroundActivityDialog.js";
import type { PollingSettings, PollingStatusMap } from "../lib/polling.js";

afterEach(cleanup);

const settings: PollingSettings = {
  minimumIntervalMs: 1_000,
  maximumIntervalMs: 3_600_000,
  loops: [
    {
      key: "importJobs",
      label: "Import progress",
      description: "Refreshes import job progress.",
      enabled: true,
      intervalMs: 15_000,
      defaultIntervalMs: 15_000,
      activeIntervalMs: 1_500,
      defaultActiveIntervalMs: 1_500,
      activeLabel: "While importing",
      customized: false
    },
    {
      key: "reviewQueue",
      label: "AI review queue",
      description: "Loads pending AI analyses.",
      enabled: false,
      intervalMs: 30_000,
      defaultIntervalMs: 30_000,
      activeIntervalMs: null,
      defaultActiveIntervalMs: null,
      activeLabel: null,
      customized: true
    }
  ]
};

const statuses: PollingStatusMap = {
  importJobs: {
    key: "importJobs",
    mounted: true,
    running: false,
    effectiveIntervalMs: 1_500,
    usingActiveInterval: true,
    lastRunAt: Date.now() - 3_000,
    lastDurationMs: 412,
    lastError: null,
    runCount: 27,
    errorCount: 0,
    nextRunAt: Date.now() + 1_200
  },
  reviewQueue: {
    key: "reviewQueue",
    mounted: false,
    running: false,
    effectiveIntervalMs: null,
    usingActiveInterval: false,
    lastRunAt: Date.now() - 90_000,
    lastDurationMs: 8_400,
    lastError: "Request failed (502)",
    runCount: 4,
    errorCount: 2,
    nextRunAt: null
  }
};

describe("BackgroundActivityDialog", () => {
  it("renders nothing until it is opened", () => {
    const { container } = render(
      <BackgroundActivityDialog
        open={false}
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={async () => {}}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows each loop with its live status", () => {
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={async () => {}}
      />
    );
    expect(screen.getByText("Import progress")).toBeTruthy();
    expect(screen.getByText("412 ms")).toBeTruthy();
    expect(screen.getByText("27")).toBeTruthy();
    // A paused loop reads as paused rather than as an idle one.
    expect(screen.getByText("Paused")).toBeTruthy();
    // Failures are surfaced instead of being swallowed.
    expect(screen.getByText(/Request failed \(502\)/)).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();
  });

  it("pauses a running loop", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause Import progress" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("importJobs", { enabled: false }));
  });

  it("resumes a paused loop", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume AI review queue" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("reviewQueue", { enabled: true }));
  });

  it("saves an edited interval in milliseconds", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={onUpdate}
      />
    );
    const input = screen.getByLabelText("AI review queue interval in seconds");
    fireEvent.blur(input, { target: { value: "120" } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("reviewQueue", { intervalMs: 120_000 }));
  });

  it("does not save when the interval is unchanged", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={onUpdate}
      />
    );
    const input = screen.getByLabelText("AI review queue interval in seconds");
    fireEvent.blur(input, { target: { value: "30" } });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a rejected save instead of failing silently", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("Unknown polling loop"));
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause Import progress" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unknown polling loop"));
  });

  it("locks the controls for a non-admin viewer", () => {
    render(
      <BackgroundActivityDialog
        open
        onClose={() => {}}
        settings={settings}
        statuses={statuses}
        onUpdate={async () => {}}
        readOnly
      />
    );
    expect(screen.getByRole("button", { name: "Pause Import progress" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("AI review queue interval in seconds").hasAttribute("disabled")).toBe(true);
  });
});
