import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StockService } from "./stock-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("StockService", () => {
  it("fetches, calculates, caches, and persists normalized ticker quotes", async () => {
    const dataDir = await temporaryDirectory();
    const fetchQuote = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      chart: {
        result: [{
          meta: {
            currency: "USD",
            longName: "Microsoft Corporation",
            regularMarketPrice: 510,
            chartPreviousClose: 500,
            regularMarketTime: 1_784_296_162,
            marketState: "REGULAR"
          }
        }],
        error: null
      }
    }), { status: 200 }));
    const service = new StockService(dataDir, fetchQuote as unknown as typeof fetch);

    expect(service.view()).toMatchObject({ symbols: ["SPY", "QQQ", "AAPL"], secondsPerSymbol: 8 });
    service.update({ symbols: ["msft", "MSFT"], secondsPerSymbol: 15 });
    expect(service.view()).toMatchObject({ symbols: ["MSFT"], secondsPerSymbol: 15 });

    const first = await service.quotes();
    const second = await service.quotes();
    expect(first).toEqual([expect.objectContaining({
      symbol: "MSFT",
      name: "Microsoft Corporation",
      price: 510,
      change: 10,
      changePercent: 2,
      currency: "USD",
      error: null
    })]);
    expect(second).toEqual(first);
    expect(fetchQuote).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(dataDir, "stock-settings.json"), "utf8"))).toEqual({
      symbols: ["MSFT"],
      secondsPerSymbol: 15
    });
    expect((await stat(service.settingsPath)).mode & 0o777).toBe(0o600);

    const reloaded = new StockService(dataDir, fetchQuote as unknown as typeof fetch);
    expect(reloaded.view()).toMatchObject({ symbols: ["MSFT"], secondsPerSymbol: 15 });
  });

  it("returns an unavailable item instead of failing the entire ticker", async () => {
    const dataDir = await temporaryDirectory();
    const fetchQuote = vi.fn().mockRejectedValue(new Error("provider offline"));
    const service = new StockService(dataDir, fetchQuote as unknown as typeof fetch);
    service.update({ symbols: ["AAPL"], secondsPerSymbol: 8 });

    await expect(service.quotes()).resolves.toEqual([expect.objectContaining({
      symbol: "AAPL",
      price: null,
      error: "provider offline"
    })]);
  });

  it("defaults the scroll speed for settings files saved before it existed", async () => {
    const dataDir = await temporaryDirectory();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dataDir, "stock-settings.json"), JSON.stringify({ symbols: ["AAPL"] }));

    const service = new StockService(dataDir, vi.fn() as unknown as typeof fetch);
    expect(service.view()).toMatchObject({ symbols: ["AAPL"], secondsPerSymbol: 8, configurationError: null });
  });

  it("rejects a scroll speed outside the allowed range", async () => {
    const dataDir = await temporaryDirectory();
    const service = new StockService(dataDir, vi.fn() as unknown as typeof fetch);
    expect(() => service.update({ symbols: ["AAPL"], secondsPerSymbol: 1 })).toThrow();
    expect(() => service.update({ symbols: ["AAPL"], secondsPerSymbol: 61 })).toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-stocks-"));
  directories.push(directory);
  return directory;
}
