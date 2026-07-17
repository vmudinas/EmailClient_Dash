import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsHeadline } from "@email-client/shared";
import { NewsTickerBar } from "./NewsTickerBar.js";

afterEach(cleanup);

describe("NewsTickerBar", () => {
  it("shows headlines with source labels in a repeated scrolling row, each linking out", () => {
    const headlines: NewsHeadline[] = [{
      id: "https://bbc.test/1",
      sourceId: "bbc",
      sourceName: "BBC News",
      title: "Breaking: something happened",
      link: "https://bbc.test/1",
      publishedAt: "2026-07-17T12:00:00.000Z"
    }, {
      id: "https://aljazeera.test/1",
      sourceId: "aljazeera",
      sourceName: "Al Jazeera",
      title: "World leaders meet",
      link: "https://aljazeera.test/1",
      publishedAt: null
    }];
    const onRefresh = vi.fn();
    render(<NewsTickerBar headlines={headlines} loading={false} error="" secondsPerHeadline={8} onRefresh={onRefresh} />);

    expect(screen.getAllByText("BBC News")).toHaveLength(3);
    expect(screen.getAllByText("Breaking: something happened")).toHaveLength(3);
    expect(screen.getAllByText("Al Jazeera")).toHaveLength(3);
    expect(screen.getAllByText("World leaders meet")).toHaveLength(3);

    const links = document.querySelectorAll(".news-ticker-headline");
    expect(links).toHaveLength(6);
    const visibleLink = screen.getByRole("link", { name: /Breaking: something happened/ });
    expect(visibleLink.getAttribute("href")).toBe("https://bbc.test/1");
    expect(visibleLink.getAttribute("target")).toBe("_blank");
    expect(visibleLink.getAttribute("rel")).toBe("noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "Refresh headlines" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    const track = document.querySelector(".news-ticker-track") as HTMLElement;
    expect(track.style.animationDuration).toBe("24s");
  });

  it("scrolls slower as more headlines are shown, instead of a fixed duration", () => {
    const headlines: NewsHeadline[] = Array.from({ length: 10 }, (_, index) => ({
      id: `https://bbc.test/${index}`,
      sourceId: "bbc",
      sourceName: "BBC News",
      title: `Story ${index}`,
      link: `https://bbc.test/${index}`,
      publishedAt: null
    }));
    render(<NewsTickerBar headlines={headlines} loading={false} error="" secondsPerHeadline={8} onRefresh={vi.fn()} />);

    const track = document.querySelector(".news-ticker-track") as HTMLElement;
    expect(track.style.animationDuration).toBe("80s");
  });

  it("honors a configured seconds-per-headline pace from Admin settings", () => {
    const headlines: NewsHeadline[] = Array.from({ length: 5 }, (_, index) => ({
      id: `https://bbc.test/${index}`,
      sourceId: "bbc",
      sourceName: "BBC News",
      title: `Story ${index}`,
      link: `https://bbc.test/${index}`,
      publishedAt: null
    }));
    render(<NewsTickerBar headlines={headlines} loading={false} error="" secondsPerHeadline={20} onRefresh={vi.fn()} />);

    const track = document.querySelector(".news-ticker-track") as HTMLElement;
    expect(track.style.animationDuration).toBe("100s");
  });

  it("directs an empty ticker to Admin settings", () => {
    render(<NewsTickerBar headlines={[]} loading={false} error="" secondsPerHeadline={8} onRefresh={vi.fn()} />);
    expect(screen.getByText("Enable sources in Admin settings → News")).toBeTruthy();
  });

  it("shows the error message when headlines fail to load", () => {
    render(<NewsTickerBar headlines={[]} loading={false} error="Headlines are unavailable" secondsPerHeadline={8} onRefresh={vi.fn()} />);
    expect(screen.getByText("Headlines are unavailable")).toBeTruthy();
  });
});
