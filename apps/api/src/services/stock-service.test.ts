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

    expect(service.view().symbols).toEqual(["SPY", "QQQ", "AAPL"]);
    service.update({ symbols: ["msft", "MSFT"] });
    expect(service.view().symbols).toEqual(["MSFT"]);

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
    expect(JSON.parse(await readFile(join(dataDir, "stock-settings.json"), "utf8"))).toEqual({ symbols: ["MSFT"] });
    expect((await stat(service.settingsPath)).mode & 0o777).toBe(0o600);

    const reloaded = new StockService(dataDir, fetchQuote as unknown as typeof fetch);
    expect(reloaded.view().symbols).toEqual(["MSFT"]);
  });

  it("returns an unavailable item instead of failing the entire ticker", async () => {
    const dataDir = await temporaryDirectory();
    const fetchQuote = vi.fn().mockRejectedValue(new Error("provider offline"));
    const service = new StockService(dataDir, fetchQuote as unknown as typeof fetch);
    service.update({ symbols: ["AAPL"] });

    await expect(service.quotes()).resolves.toEqual([expect.objectContaining({
      symbol: "AAPL",
      price: null,
      error: "provider offline"
    })]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-stocks-"));
  directories.push(directory);
  return directory;
}
