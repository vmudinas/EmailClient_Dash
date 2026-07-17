import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StockQuote } from "@email-client/shared";
import { StockTickerBar } from "./StockTickerBar.js";

afterEach(cleanup);

describe("StockTickerBar", () => {
  it("shows prices and changes in a repeated scrolling market row", () => {
    const quotes: StockQuote[] = [{
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 189.25,
      currency: "USD",
      change: 1.25,
      changePercent: 0.67,
      marketState: "REGULAR",
      quotedAt: "2026-07-17T14:00:00.000Z",
      error: null
    }, {
      symbol: "BAD",
      name: null,
      price: null,
      currency: null,
      change: null,
      changePercent: null,
      marketState: null,
      quotedAt: "2026-07-17T14:00:00.000Z",
      error: "Price unavailable"
    }];
    const onRefresh = vi.fn();
    render(<StockTickerBar quotes={quotes} loading={false} error="" onRefresh={onRefresh} />);

    expect(screen.getAllByText("AAPL")).toHaveLength(3);
    expect(screen.getAllByText("$189.25")).toHaveLength(3);
    expect(screen.getAllByText("+0.67%")).toHaveLength(3);
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Refresh market prices" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("directs an empty ticker to Admin settings", () => {
    render(<StockTickerBar quotes={[]} loading={false} error="" onRefresh={vi.fn()} />);
    expect(screen.getByText("Add symbols in Admin settings → Stocks")).toBeTruthy();
  });
});
