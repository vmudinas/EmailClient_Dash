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
  NEWS_SOURCE_IDS,
  NEWS_SOURCE_LABELS,
  newsSettingsPatchSchema,
  type AdminSettings,
  type NewsHeadline,
  type NewsSettingsPatch,
  type NewsSourceId
} from "@email-client/shared";

const SETTINGS_FILENAME = "news-settings.json";
const DEFAULT_ENABLED_SOURCES = [...NEWS_SOURCE_IDS];
const DEFAULT_SECONDS_PER_HEADLINE = 8;
const HEADLINES_CACHE_MS = 10 * 60_000;
const FEED_TIMEOUT_MS = 8_000;
const ITEMS_PER_SOURCE = 12;
const HEADLINES_LIMIT = 40;

// Publisher-hosted RSS 2.0 feeds, no API key required. CNN retired its long-standing
// rss.cnn.com feeds in some regions; kept here with graceful per-source failure so a
// dead CNN feed doesn't take down the other three.
const SOURCE_FEEDS: Record<NewsSourceId, string> = {
  cnn: "http://rss.cnn.com/rss/edition.rss",
  bbc: "https://feeds.bbci.co.uk/news/rss.xml",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml",
  foxnews: "https://moxie.foxnews.com/google-publisher/latest.xml"
};

interface CachedSource {
  expiresAt: number;
  headlines: NewsHeadline[];
}

export class NewsService {
  readonly settingsPath: string;
  private persisted: NewsSettingsPatch = {
    enabledSources: [...DEFAULT_ENABLED_SOURCES],
    secondsPerHeadline: DEFAULT_SECONDS_PER_HEADLINE
  };
  private readError: string | null = null;
  private readonly cache = new Map<NewsSourceId, CachedSource>();

  constructor(
    dataDir: string,
    private readonly fetchFeed: typeof fetch = fetch
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  view(): AdminSettings["news"] {
    return {
      enabledSources: [...this.persisted.enabledSources],
      secondsPerHeadline: this.persisted.secondsPerHeadline,
      settingsPath: this.settingsPath,
      configurationError: this.readError
    };
  }

  update(input: NewsSettingsPatch): AdminSettings["news"] {
    const parsed = newsSettingsPatchSchema.parse(input);
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = parsed;
    this.readError = null;
    return this.view();
  }

  async headlines(): Promise<NewsHeadline[]> {
    const results = await Promise.all(this.persisted.enabledSources.map((sourceId) => this.sourceHeadlines(sourceId)));
    const merged = results.flat();
    merged.sort((a, b) => {
      if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });
    return merged.slice(0, HEADLINES_LIMIT);
  }

  private async sourceHeadlines(sourceId: NewsSourceId): Promise<NewsHeadline[]> {
    const cached = this.cache.get(sourceId);
    if (cached && cached.expiresAt > Date.now()) return cached.headlines;

    let headlines: NewsHeadline[];
    try {
      const response = await this.fetchFeed(SOURCE_FEEDS[sourceId], {
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml",
          "User-Agent": "ArchiveMail/0.1"
        },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`News provider returned ${response.status}`);
      headlines = parseRssItems(await response.text(), ITEMS_PER_SOURCE).map((item) => ({
        id: item.link,
        sourceId,
        sourceName: NEWS_SOURCE_LABELS[sourceId],
        title: item.title,
        link: item.link,
        publishedAt: item.pubDate ? parseFeedDate(item.pubDate) : null
      }));
    } catch {
      // One source failing (dead feed, network blip, geo-block) shouldn't blank the whole ticker.
      headlines = [];
    }

    this.cache.set(sourceId, { headlines, expiresAt: Date.now() + HEADLINES_CACHE_MS });
    return headlines;
  }

  private read(): NewsSettingsPatch {
    const defaults: NewsSettingsPatch = {
      enabledSources: [...DEFAULT_ENABLED_SOURCES],
      secondsPerHeadline: DEFAULT_SECONDS_PER_HEADLINE
    };
    if (!existsSync(this.settingsPath)) return defaults;
    try {
      const parsed = newsSettingsPatchSchema.parse(JSON.parse(readFileSync(this.settingsPath, "utf8")));
      chmodSync(this.settingsPath, 0o600);
      return parsed;
    } catch (error) {
      this.readError = `Saved news settings could not be loaded: ${errorMessage(error)}`;
      return defaults;
    }
  }
}

interface RssItem {
  title: string;
  link: string;
  pubDate: string | null;
}

function parseRssItems(xml: string, limit: number): RssItem[] {
  const items: RssItem[] = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while (items.length < limit && (match = itemPattern.exec(xml))) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title");
    const link = extractLink(block);
    if (!title || !link) continue;
    items.push({ title, link, pubDate: extractTag(block, "pubDate") });
  }
  return items;
}

function extractTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  if (!match) return null;
  const raw = match[1]?.trim() ?? "";
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  const value = decodeXmlEntities((cdata ? cdata[1] : raw) ?? "").trim();
  return value || null;
}

function extractLink(block: string): string | null {
  const tagValue = extractTag(block, "link");
  if (tagValue && /^https?:\/\//i.test(tagValue)) return tagValue;
  const attrMatch = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
  return attrMatch ? decodeXmlEntities(attrMatch[1] ?? "").trim() || null : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseFeedDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
