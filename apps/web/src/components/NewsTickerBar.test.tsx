import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsHeadline } from "@email-client/shared";
import { NewsTickerBar } from "./NewsTickerBar.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("NewsTickerBar", () => {
  it("shows headlines with source labels and asks before opening an article", () => {
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

    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(visibleLink);
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Open or remove this story?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open article" }));
    expect(open).toHaveBeenCalledWith("https://bbc.test/1", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "Refresh headlines" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    const track = document.querySelector(".news-ticker-track") as HTMLElement;
    expect(track.style.animationDuration).toBe("24s");
  });

  it("gives the story dialog a clear action hierarchy that survives narrow widths", () => {
    const headline: NewsHeadline = {
      id: "https://aj.test/1",
      sourceId: "aljazeera",
      sourceName: "Al Jazeera",
      title: "A headline long enough that three side-by-side buttons would not fit on one row",
      link: "https://aj.test/1",
      publishedAt: null
    };
    render(<NewsTickerBar headlines={[headline]} loading={false} error="" secondsPerHeadline={8} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: /A headline long enough/ }));

    // The primary action is focused so keyboard and screen-reader users land on it.
    const openArticle = screen.getByRole("button", { name: "Open article" });
    expect(document.activeElement).toBe(openArticle);

    // Each action carries its own class so the layout can order them per breakpoint: the destructive
    // action to one side, cancel then confirm to the other, and a full-width stack on narrow screens.
    expect(openArticle.className).toContain("news-action-open");
    expect(screen.getByRole("button", { name: "Remove from feed" }).className).toContain("news-action-remove");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("news-action-cancel");

    // Decorative icons must not leak into the accessible name.
    expect(openArticle.querySelectorAll("svg[aria-hidden=\"true\"]").length).toBe(1);
  });

  it("removes a selected story from every ticker copy and remembers the dismissal", () => {
    const headline: NewsHeadline = {
      id: "https://bbc.test/remove-me",
      sourceId: "bbc",
      sourceName: "BBC News",
      title: "Remove this story",
      link: "https://bbc.test/remove-me",
      publishedAt: null
    };
    const first = render(<NewsTickerBar headlines={[headline]} loading={false} error="" secondsPerHeadline={8} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("link", { name: /Remove this story/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from feed" }));
    expect(screen.queryByText("Remove this story")).toBeNull();
    expect(screen.getByText("All current headlines were removed")).toBeTruthy();

    first.unmount();
    render(<NewsTickerBar headlines={[headline]} loading={false} error="" secondsPerHeadline={8} onRefresh={vi.fn()} />);
    expect(screen.queryByText("Remove this story")).toBeNull();
    expect(screen.getByText("All current headlines were removed")).toBeTruthy();
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
