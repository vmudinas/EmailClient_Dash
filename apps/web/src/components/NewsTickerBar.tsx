import { useMemo, useState } from "react";
import { ExternalLink, LoaderCircle, Newspaper, RefreshCw, Trash2, X } from "lucide-react";
import type { NewsHeadline } from "@email-client/shared";

const DISMISSED_NEWS_STORAGE_KEY = "archive-mail-dismissed-news-v1";
const MAX_DISMISSED_HEADLINES = 500;

interface NewsTickerBarProps {
  headlines: NewsHeadline[];
  loading: boolean;
  error: string;
  secondsPerHeadline: number;
  onRefresh(): void;
}

export function NewsTickerBar({ headlines, loading, error, secondsPerHeadline, onRefresh }: NewsTickerBarProps) {
  const [selectedHeadline, setSelectedHeadline] = useState<NewsHeadline | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(readDismissedHeadlineIds);
  const visibleHeadlines = useMemo(
    () => headlines.filter((headline) => !dismissedIds.has(headline.id)),
    [dismissedIds, headlines]
  );
  const content = visibleHeadlines.length > 0 ? visibleHeadlines : null;
  // Longer headline lists move the ticker track further per lap, so a fixed animation
  // duration makes each item flash by faster as more sources are enabled. Scaling the
  // duration by item count keeps the per-headline dwell time at the configured pace
  // regardless of how many headlines are currently showing.
  const minDurationSeconds = Math.max(15, secondsPerHeadline * 3);
  const durationSeconds = Math.max(minDurationSeconds, (content?.length ?? 0) * secondsPerHeadline);
  const removeHeadline = () => {
    if (!selectedHeadline) return;
    const nextIds = new Set(dismissedIds);
    nextIds.add(selectedHeadline.id);
    const limitedIds = new Set([...nextIds].slice(-MAX_DISMISSED_HEADLINES));
    setDismissedIds(limitedIds);
    writeDismissedHeadlineIds(limitedIds);
    setSelectedHeadline(null);
  };
  const openHeadline = () => {
    if (!selectedHeadline) return;
    window.open(selectedHeadline.link, "_blank", "noopener,noreferrer");
    setSelectedHeadline(null);
  };

  return (
    <>
      <footer className="news-ticker-bar" aria-label="Breaking news">
        <span className="news-ticker-label"><Newspaper size={13} /> News</span>
        <div className="news-ticker-viewport">
          {content ? (
            <div className="news-ticker-track" style={{ animationDuration: `${durationSeconds}s` }}>
              {[0, 1, 2].map((copy) => (
                <div className="news-ticker-group" key={copy} aria-hidden={copy > 0 || undefined}>
                  {content.map((headline) => <NewsTickerHeadline key={`${copy}-${headline.id}`} headline={headline} onSelect={setSelectedHeadline} />)}
                </div>
              ))}
            </div>
          ) : (
            <span className={`news-ticker-empty${error ? " error" : ""}`}>
              {error || (loading ? "Loading headlines…" : headlines.length > 0 ? "All current headlines were removed" : "Enable sources in Admin settings → News")}
            </span>
          )}
        </div>
        <button
          type="button"
          className="news-ticker-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh headlines"
          aria-label="Refresh headlines"
        >
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </footer>
      {selectedHeadline && (
        <div className="news-action-backdrop" role="presentation" onMouseDown={() => setSelectedHeadline(null)}>
          <section className="news-action-dialog" role="dialog" aria-modal="true" aria-labelledby="news-action-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>{selectedHeadline.sourceName}</span>
                <h2 id="news-action-title">Open or remove this story?</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setSelectedHeadline(null)} aria-label="Close news action"><X size={18} /></button>
            </header>
            <p>{selectedHeadline.title}</p>
            <footer>
              <button type="button" className="primary-button news-action-open" onClick={openHeadline} autoFocus>
                <ExternalLink size={16} aria-hidden="true" /> <span>Open article</span>
              </button>
              <button type="button" className="danger-button news-action-remove" onClick={removeHeadline}>
                <Trash2 size={16} aria-hidden="true" /> <span>Remove from feed</span>
              </button>
              <button type="button" className="secondary-button news-action-cancel" onClick={() => setSelectedHeadline(null)}>Cancel</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function NewsTickerHeadline({ headline, onSelect }: { headline: NewsHeadline; onSelect(headline: NewsHeadline): void }) {
  const title = headline.publishedAt
    ? `${headline.sourceName} · ${new Date(headline.publishedAt).toLocaleString()}`
    : headline.sourceName;
  return (
    <a
      className="news-ticker-headline"
      href={headline.link}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(event) => {
        event.preventDefault();
        onSelect(headline);
      }}
    >
      <strong>{headline.sourceName}</strong>
      <span>{headline.title}</span>
    </a>
  );
}

function readDismissedHeadlineIds(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_NEWS_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissedHeadlineIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_NEWS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // A private or quota-limited browser can still dismiss headlines for this session.
  }
}
