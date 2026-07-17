import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  stockSettingsPatchSchema,
  type AdminSettings,
  type StockQuote,
  type StockSettingsPatch
} from "@email-client/shared";

const SETTINGS_FILENAME = "stock-settings.json";
const DEFAULT_SYMBOLS = ["SPY", "QQQ", "AAPL"];
const QUOTE_CACHE_MS = 60_000;
const QUOTE_TIMEOUT_MS = 8_000;

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: unknown;
        symbol?: unknown;
        longName?: unknown;
        shortName?: unknown;
        regularMarketPrice?: unknown;
        chartPreviousClose?: unknown;
        previousClose?: unknown;
        regularMarketTime?: unknown;
        marketState?: unknown;
      };
    }> | null;
    error?: { description?: unknown } | null;
  };
}

interface CachedQuote {
  expiresAt: number;
  quote: StockQuote;
}

export class StockService {
  readonly settingsPath: string;
  private persisted: StockSettingsPatch = { symbols: [...DEFAULT_SYMBOLS] };
  private readError: string | null = null;
  private readonly cache = new Map<string, CachedQuote>();

  constructor(
    dataDir: string,
    private readonly fetchQuote: typeof fetch = fetch
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  view(): AdminSettings["stocks"] {
    return {
      symbols: [...this.persisted.symbols],
      settingsPath: this.settingsPath,
      configurationError: this.readError
    };
  }

  update(input: StockSettingsPatch): AdminSettings["stocks"] {
    const parsed = stockSettingsPatchSchema.parse(input);
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = parsed;
    this.readError = null;
    for (const symbol of this.cache.keys()) {
      if (!parsed.symbols.includes(symbol)) this.cache.delete(symbol);
    }
    return this.view();
  }

  async quotes(): Promise<StockQuote[]> {
    return Promise.all(this.persisted.symbols.map((symbol) => this.quote(symbol)));
  }

  private async quote(symbol: string): Promise<StockQuote> {
    const cached = this.cache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.quote;

    let quote: StockQuote;
    try {
      const response = await this.fetchQuote(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "ArchiveMail/0.1"
          },
          signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS)
        }
      );
      if (!response.ok) throw new Error(`Quote provider returned ${response.status}`);
      quote = parseQuote(symbol, await response.json() as YahooChartResponse);
    } catch (error) {
      quote = unavailableQuote(symbol, errorMessage(error));
    }

    this.cache.set(symbol, { quote, expiresAt: Date.now() + QUOTE_CACHE_MS });
    return quote;
  }

  private read(): StockSettingsPatch {
    if (!existsSync(this.settingsPath)) return { symbols: [...DEFAULT_SYMBOLS] };
    try {
      const parsed = stockSettingsPatchSchema.parse(JSON.parse(readFileSync(this.settingsPath, "utf8")));
      chmodSync(this.settingsPath, 0o600);
      return parsed;
    } catch (error) {
      this.readError = `Saved stock settings could not be loaded: ${errorMessage(error)}`;
      return { symbols: [...DEFAULT_SYMBOLS] };
    }
  }
}

function parseQuote(symbol: string, payload: YahooChartResponse): StockQuote {
  const providerError = payload.chart?.error?.description;
  if (typeof providerError === "string" && providerError) throw new Error(providerError);
  const meta = payload.chart?.result?.[0]?.meta;
  const price = numberValue(meta?.regularMarketPrice);
  if (price === null) throw new Error("No current price is available");
  const previousClose = numberValue(meta?.chartPreviousClose) ?? numberValue(meta?.previousClose);
  const change = previousClose === null ? null : price - previousClose;
  const quoteTime = numberValue(meta?.regularMarketTime);
  return {
    symbol,
    name: stringValue(meta?.longName) ?? stringValue(meta?.shortName),
    price,
    currency: stringValue(meta?.currency),
    change,
    changePercent: previousClose && change !== null ? (change / previousClose) * 100 : null,
    marketState: stringValue(meta?.marketState),
    quotedAt: quoteTime === null ? new Date().toISOString() : new Date(quoteTime * 1_000).toISOString(),
    error: null
  };
}

function unavailableQuote(symbol: string, error: string): StockQuote {
  return {
    symbol,
    name: null,
    price: null,
    currency: null,
    change: null,
    changePercent: null,
    marketState: null,
    quotedAt: new Date().toISOString(),
    error
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
