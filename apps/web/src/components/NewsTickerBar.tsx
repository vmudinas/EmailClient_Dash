import { LoaderCircle, Newspaper, RefreshCw } from "lucide-react";
import type { NewsHeadline } from "@email-client/shared";

interface NewsTickerBarProps {
  headlines: NewsHeadline[];
  loading: boolean;
  error: string;
  secondsPerHeadline: number;
  onRefresh(): void;
}

export function NewsTickerBar({ headlines, loading, error, secondsPerHeadline, onRefresh }: NewsTickerBarProps) {
  const content = headlines.length > 0 ? headlines : null;
  // Longer headline lists move the ticker track further per lap, so a fixed animation
  // duration makes each item flash by faster as more sources are enabled. Scaling the
  // duration by item count keeps the per-headline dwell time at the configured pace
  // regardless of how many headlines are currently showing.
  const minDurationSeconds = Math.max(15, secondsPerHeadline * 3);
  const durationSeconds = Math.max(minDurationSeconds, (content?.length ?? 0) * secondsPerHeadline);
  return (
    <footer className="news-ticker-bar" aria-label="Breaking news">
      <span className="news-ticker-label"><Newspaper size={13} /> News</span>
      <div className="news-ticker-viewport">
        {content ? (
          <div className="news-ticker-track" style={{ animationDuration: `${durationSeconds}s` }}>
            {[0, 1, 2].map((copy) => (
              <div className="news-ticker-group" key={copy} aria-hidden={copy > 0 || undefined}>
                {content.map((headline) => <NewsTickerHeadline key={`${copy}-${headline.id}`} headline={headline} />)}
              </div>
            ))}
          </div>
        ) : (
          <span className={`news-ticker-empty${error ? " error" : ""}`}>
            {error || (loading ? "Loading headlines…" : "Enable sources in Admin settings → News")}
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
  );
}

function NewsTickerHeadline({ headline }: { headline: NewsHeadline }) {
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
    >
      <strong>{headline.sourceName}</strong>
      <span>{headline.title}</span>
    </a>
  );
}
