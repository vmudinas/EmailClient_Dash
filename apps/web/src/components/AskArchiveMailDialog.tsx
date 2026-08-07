import { ChevronDown, ChevronRight, History, LoaderCircle, Mail, Search, Send, Sparkles, X } from "lucide-react";
import { useState } from "react";
import type { AskAnswer, AskFilters, AskHistoryEntry } from "@email-client/shared";
import { formatDateTime } from "../lib/format.js";

interface AskArchiveMailDialogProps {
  open: boolean;
  answer: AskAnswer | null;
  history: AskHistoryEntry[];
  asking: boolean;
  historyLoading: boolean;
  onClose(): void;
  onAsk(question: string, filters: AskFilters): void;
  onOpenMessage(messageId: string): void;
  onRefreshHistory(): void;
}

export function AskArchiveMailDialog({
  open,
  answer,
  history,
  asking,
  historyLoading,
  onClose,
  onAsk,
  onOpenMessage,
  onRefreshHistory
}: AskArchiveMailDialogProps) {
  const [question, setQuestion] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [senderAddress, setSenderAddress] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [consultedOpen, setConsultedOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!open) return null;

  const trimmed = question.trim();
  const submit = () => {
    if (!trimmed || asking) return;
    onAsk(trimmed, {
      ...(senderAddress.trim() ? { senderAddress: senderAddress.trim() } : {}),
      ...(since.trim() ? { since: since.trim() } : {}),
      ...(until.trim() ? { until: until.trim() } : {})
    });
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!asking) onClose(); }}>
      <section
        className="dialog ask-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div><Sparkles size={20} /><h2 id="ask-title">Ask Archive Mail</h2></div>
          <div className="dialog-header-actions">
            <button
              className="icon-button"
              onClick={() => { setHistoryOpen((value) => !value); if (!historyOpen) onRefreshHistory(); }}
              title="Recent questions"
              aria-label="Recent questions"
              aria-pressed={historyOpen}
            >
              <History size={17} />
            </button>
            <button className="icon-button" disabled={asking} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body ask-body">
          <form
            className="ask-form"
            onSubmit={(event) => { event.preventDefault(); submit(); }}
          >
            <label className="ask-question-field">
              <span className="visually-hidden">Question</span>
              <textarea
                autoFocus
                rows={3}
                value={question}
                maxLength={1000}
                disabled={asking}
                placeholder="Ask about your mail — e.g. What do I need to reply to today?"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
            <div className="ask-form-actions">
              <button
                type="button"
                className="ask-filter-toggle"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((value) => !value)}
              >
                {filtersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Filters
              </button>
              <button type="submit" className="primary-button" disabled={!trimmed || asking}>
                {asking ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
                <span>{asking ? "Searching your mail" : "Ask"}</span>
              </button>
            </div>
            {filtersOpen && (
              <div className="ask-filters">
                <label>
                  <span>From address</span>
                  <input
                    value={senderAddress}
                    disabled={asking}
                    placeholder="owner@example.com"
                    onChange={(event) => setSenderAddress(event.target.value)}
                  />
                </label>
                <label>
                  <span>Since</span>
                  <input type="date" value={since} disabled={asking} onChange={(event) => setSince(event.target.value)} />
                </label>
                <label>
                  <span>Until</span>
                  <input type="date" value={until} disabled={asking} onChange={(event) => setUntil(event.target.value)} />
                </label>
              </div>
            )}
          </form>

          <p className="ask-privacy-note">
            Your mail is searched on this server. Only the matching excerpts are sent to the AI provider — never your whole mailbox.
          </p>

          {asking && !answer && (
            <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Searching your archive</div>
          )}

          {answer && !asking && (
            <section className="ask-answer" aria-label="Answer">
              <p className="ask-answer-text">{answer.answer}</p>

              {answer.citations.length > 0 ? (
                <div className="ask-citations">
                  <h3>Sources</h3>
                  <div className="ask-citation-chips">
                    {answer.citations.map((citation) => (
                      <button
                        key={citation.messageId}
                        className="ask-citation-chip"
                        onClick={() => onOpenMessage(citation.messageId)}
                        title={`Open ${citation.subject || "(No subject)"}`}
                      >
                        <Mail size={13} />
                        <span className="ask-citation-subject">{citation.subject || "(No subject)"}</span>
                        <small>{formatDateTime(citation.message.receivedAt ?? citation.message.sentAt)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                answer.excerptCount > 0 && (
                  <p className="ask-no-citations">
                    The answer did not cite a specific message. Open the consulted messages below to verify it yourself.
                  </p>
                )
              )}

              {answer.consulted.length > 0 && (
                <div className="ask-consulted">
                  <button
                    className="ask-consulted-toggle"
                    aria-expanded={consultedOpen}
                    onClick={() => setConsultedOpen((value) => !value)}
                  >
                    {consultedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Search size={13} />
                    <span>{answer.consulted.length} {answer.consulted.length === 1 ? "message" : "messages"} consulted</span>
                  </button>
                  {consultedOpen && (
                    <ul className="ask-consulted-list">
                      {answer.consulted.map((item) => (
                        <li key={item.messageId}>
                          <button onClick={() => onOpenMessage(item.messageId)}>
                            <strong>{item.subject || "(No subject)"}</strong>
                            <small>{item.sender} · {formatDateTime(item.receivedAt)}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <footer className="ask-answer-meta">
                Answered by {answer.provider} · {answer.model}
              </footer>
            </section>
          )}

          {historyOpen && (
            <section className="ask-history" aria-label="Recent questions">
              <h3>Recent questions</h3>
              {historyLoading ? (
                <div className="settings-loading"><LoaderCircle className="spin" size={16} /> Loading history</div>
              ) : history.length === 0 ? (
                <p className="ask-history-empty">You have not asked anything yet.</p>
              ) : (
                <ul className="ask-history-list">
                  {history.map((entry) => (
                    <li key={entry.id}>
                      <button onClick={() => setQuestion(entry.question)} title="Reuse this question">
                        <strong>{entry.question}</strong>
                        <small>{formatDateTime(entry.createdAt)} · {entry.citations.length} cited</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!answer && !asking && !historyOpen && (
            <div className="ask-empty">
              <Sparkles size={28} />
              <strong>Ask a question about your mail</strong>
              <span>Answers cite the messages they came from, so you can check every claim.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
