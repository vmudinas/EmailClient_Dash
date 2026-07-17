import { LoaderCircle, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import type { StockQuote } from "@email-client/shared";

interface StockTickerBarProps {
  quotes: StockQuote[];
  loading: boolean;
  error: string;
  secondsPerSymbol: number;
  onRefresh(): void;
}

export function StockTickerBar({ quotes, loading, error, secondsPerSymbol, onRefresh }: StockTickerBarProps) {
  const content = quotes.length > 0 ? quotes : null;
  const minDurationSeconds = Math.max(15, secondsPerSymbol * 3);
  const durationSeconds = Math.max(minDurationSeconds, (content?.length ?? 0) * secondsPerSymbol);
  return (
    <footer className="stock-ticker-bar" aria-label="Market prices">
      <span className="stock-ticker-label"><TrendingUp size={13} /> Markets</span>
      <div className="stock-ticker-viewport">
        {content ? (
          <div className="stock-ticker-track" style={{ animationDuration: `${durationSeconds}s` }}>
            {[0, 1, 2].map((copy) => (
              <div className="stock-ticker-group" key={copy} aria-hidden={copy > 0 || undefined}>
                {content.map((quote) => <StockTickerQuote key={`${copy}-${quote.symbol}`} quote={quote} />)}
              </div>
            ))}
          </div>
        ) : (
          <span className={`stock-ticker-empty${error ? " error" : ""}`}>
            {error || (loading ? "Loading market prices…" : "Add symbols in Admin settings → Stocks")}
          </span>
        )}
      </div>
      <button
        type="button"
        className="stock-ticker-refresh"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh market prices"
        aria-label="Refresh market prices"
      >
        {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
      </button>
    </footer>
  );
}

function StockTickerQuote({ quote }: { quote: StockQuote }) {
  if (quote.price === null) {
    return (
      <span className="stock-ticker-quote unavailable" title={quote.error ?? "Price unavailable"}>
        <strong>{quote.symbol}</strong><span>Unavailable</span>
      </span>
    );
  }

  const direction = quote.change === null ? "flat" : quote.change > 0 ? "up" : quote.change < 0 ? "down" : "flat";
  const title = [quote.name, `Quoted ${new Date(quote.quotedAt).toLocaleString()}`].filter(Boolean).join(" · ");
  return (
    <span className={`stock-ticker-quote ${direction}`} title={title}>
      <strong>{quote.symbol}</strong>
      <span>{formatPrice(quote.price, quote.currency)}</span>
      {quote.changePercent !== null && (
        <em>
          {direction === "up" ? <TrendingUp size={11} /> : direction === "down" ? <TrendingDown size={11} /> : null}
          {formatPercent(quote.changePercent)}
        </em>
      )}
    </span>
  );
}

function formatPrice(price: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: price >= 100 ? 2 : 2,
        maximumFractionDigits: price < 1 ? 4 : 2
      }).format(price);
    } catch {
      // Fall through to a plain numeric price for unknown provider currencies.
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: price < 1 ? 4 : 2 }).format(price);
}

function formatPercent(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}
