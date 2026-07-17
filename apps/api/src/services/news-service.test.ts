import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsService } from "./news-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function rssFeed(items: Array<{ title: string; link: string; pubDate: string }>): string {
  const body = items.map((item) => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.link}</link>
      <guid isPermaLink="false">${item.link}</guid>
      <pubDate>${item.pubDate}</pubDate>
    </item>
  `).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${body}</channel></rss>`;
}

describe("NewsService", () => {
  it("fetches, parses, merges by recency, caches, and persists enabled sources", async () => {
    const dataDir = await temporaryDirectory();
    const calls: string[] = [];
    const fetchFeed = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("bbc")) {
        return new Response(rssFeed([
          { title: "BBC older story", link: "https://bbc.test/1", pubDate: "Fri, 17 Jul 2026 10:00:00 GMT" }
        ]), { status: 200 });
      }
      if (url.includes("aljazeera")) {
        return new Response(rssFeed([
          { title: "Al Jazeera newest story", link: "https://aljazeera.test/1", pubDate: "Fri, 17 Jul 2026 12:00:00 GMT" }
        ]), { status: 200 });
      }
      return new Response("", { status: 200 });
    });
    const service = new NewsService(dataDir, fetchFeed as unknown as typeof fetch);

    expect(service.view()).toMatchObject({
      enabledSources: ["cnn", "bbc", "aljazeera", "foxnews"],
      secondsPerHeadline: 8
    });
    service.update({ enabledSources: ["bbc", "aljazeera", "bbc"], secondsPerHeadline: 15 });
    expect(service.view()).toMatchObject({ enabledSources: ["bbc", "aljazeera"], secondsPerHeadline: 15 });

    const first = await service.headlines();
    expect(first.map((headline) => headline.title)).toEqual(["Al Jazeera newest story", "BBC older story"]);
    expect(first[0]).toMatchObject({ sourceId: "aljazeera", sourceName: "Al Jazeera", link: "https://aljazeera.test/1" });
    expect(first[0]?.publishedAt).toBe(new Date("Fri, 17 Jul 2026 12:00:00 GMT").toISOString());

    const second = await service.headlines();
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);

    expect(JSON.parse(await readFile(join(dataDir, "news-settings.json"), "utf8"))).toEqual({
      enabledSources: ["bbc", "aljazeera"],
      secondsPerHeadline: 15
    });
    expect((await stat(service.settingsPath)).mode & 0o777).toBe(0o600);

    const reloaded = new NewsService(dataDir, fetchFeed as unknown as typeof fetch);
    expect(reloaded.view()).toMatchObject({ enabledSources: ["bbc", "aljazeera"], secondsPerHeadline: 15 });
  });

  it("skips a source that fails without blanking the others", async () => {
    const dataDir = await temporaryDirectory();
    const fetchFeed = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("bbc")) {
        return new Response(rssFeed([
          { title: "BBC still works", link: "https://bbc.test/2", pubDate: "Fri, 17 Jul 2026 09:00:00 GMT" }
        ]), { status: 200 });
      }
      throw new Error("network unreachable");
    });
    const service = new NewsService(dataDir, fetchFeed as unknown as typeof fetch);
    service.update({ enabledSources: ["bbc", "cnn"], secondsPerHeadline: 8 });

    const headlines = await service.headlines();
    expect(headlines).toEqual([expect.objectContaining({ sourceId: "bbc", title: "BBC still works" })]);
  });

  it("falls back to an Atom-style href link and skips items missing a title or link", async () => {
    const dataDir = await temporaryDirectory();
    const fetchFeed = vi.fn().mockResolvedValue(new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <item>
          <title>Atom-style link item</title>
          <link href="https://example.test/atom-item" />
          <pubDate>Fri, 17 Jul 2026 08:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Missing a link</title>
        </item>
      </channel></rss>`,
      { status: 200 }
    ));
    const service = new NewsService(dataDir, fetchFeed as unknown as typeof fetch);
    service.update({ enabledSources: ["foxnews"], secondsPerHeadline: 8 });

    const headlines = await service.headlines();
    expect(headlines).toEqual([expect.objectContaining({
      title: "Atom-style link item",
      link: "https://example.test/atom-item"
    })]);
  });

  it("defaults the scroll speed for settings files saved before it existed", async () => {
    const dataDir = await temporaryDirectory();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dataDir, "news-settings.json"), JSON.stringify({ enabledSources: ["bbc"] }));

    const service = new NewsService(dataDir, vi.fn() as unknown as typeof fetch);
    expect(service.view()).toMatchObject({ enabledSources: ["bbc"], secondsPerHeadline: 8, configurationError: null });
  });

  it("rejects a scroll speed outside the allowed range", async () => {
    const dataDir = await temporaryDirectory();
    const service = new NewsService(dataDir, vi.fn() as unknown as typeof fetch);
    expect(() => service.update({ enabledSources: ["bbc"], secondsPerHeadline: 1 })).toThrow();
    expect(() => service.update({ enabledSources: ["bbc"], secondsPerHeadline: 61 })).toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-news-"));
  directories.push(directory);
  return directory;
}
