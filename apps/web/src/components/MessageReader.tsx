import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  BrainCircuit,
  Check,
  CircleAlert,
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  Save,
  Sparkles,
  Star,
  Tag,
  X
} from "lucide-react";
import type {
  AiMessageState,
  Attachment,
  LocalMessageStatePatch,
  MessageDetail
} from "@email-client/shared";
import { displayAddress, formatBytes, formatDateTime, initials } from "../lib/format.js";
import type { ApiClient } from "../lib/api.js";

interface MessageReaderProps {
  message: MessageDetail | null;
  loading: boolean;
  readOnly: boolean;
  api: ApiClient | null;
  onMobileBack(): void;
  onUpdateState(patch: LocalMessageStatePatch): Promise<void>;
  onError(message: string): void;
}

export function MessageReader({
  message,
  loading,
  readOnly,
  api,
  onMobileBack,
  onUpdateState,
  onError
}: MessageReaderProps) {
  const [note, setNote] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiState, setAiState] = useState<AiMessageState>({ job: null, analysis: null });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNote(message?.state.note ?? "");
    setTagInput(message?.state.tags.join(", ") ?? "");
    setEditingNote(false);
  }, [message?.id, message?.state.note, message?.state.tags]);

  useEffect(() => {
    const reset = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    };
    reset();
    const frame = window.requestAnimationFrame(reset);
    return () => window.cancelAnimationFrame(frame);
  }, [message?.id]);

  useEffect(() => {
    let active = true;
    setAiState({ job: null, analysis: null });
    setAiError("");
    if (!api || !message?.id) return () => { active = false; };
    setAiLoading(true);
    void api.getMessageAiState(message.id)
      .then((state) => { if (active) setAiState(state); })
      .catch((error) => { if (active) setAiError(errorText(error)); })
      .finally(() => { if (active) setAiLoading(false); });
    return () => { active = false; };
  }, [api, message?.id]);

  useEffect(() => {
    const job = aiState.job;
    if (!api || !message?.id || !job || (job.status !== "queued" && job.status !== "running")) return;
    let active = true;
    const refresh = async () => {
      try {
        const state = await api.getMessageAiState(message.id);
        if (active) setAiState(state);
      } catch (error) {
        if (active) setAiError(errorText(error));
      }
    };
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, message?.id, aiState.job?.id, aiState.job?.status]);


  if (loading) {
    return (
      <section className="reader-pane reader-loading">
        <LoaderCircle className="spin" size={22} /> Loading message
      </section>
    );
  }

  if (!message) {
    return (
      <section className="reader-pane reader-empty">
        <Mail size={36} />
        <strong>Select a message</strong>
        <span>Choose an email from the list to open it.</span>
      </section>
    );
  }

  const saveMetadata = async () => {
    setSaving(true);
    try {
      await onUpdateState({
        note,
        tags: tagInput.split(",").map((tag) => tag.trim()).filter(Boolean)
      });
      setEditingNote(false);
    } finally {
      setSaving(false);
    }
  };

  const analyze = async () => {
    if (!api || !message) return;
    setAiLoading(true);
    setAiError("");
    try {
      const result = await api.analyzeMessage(message.id);
      setAiState(result);
    } catch (error) {
      setAiError(errorText(error));
    } finally {
      setAiLoading(false);
    }
  };

  const cancelAnalysis = async () => {
    if (!api || !aiState.job) return;
    setAiLoading(true);
    try {
      const job = await api.cancelAiJob(aiState.job.id);
      setAiState((current) => ({ ...current, job }));
    } catch (error) {
      setAiError(errorText(error));
    } finally {
      setAiLoading(false);
    }
  };

  const analysisActive = aiState.job?.status === "queued" || aiState.job?.status === "running";

  return (
    <article className="reader-pane" aria-label={message.subject}>
      <header className="reader-toolbar">
        <button className="icon-button mobile-only" onClick={onMobileBack} title="Back to messages" aria-label="Back to messages">
          <ArrowLeft size={18} />
        </button>
        <span className="reader-location">{message.folderPath}</span>
        <div className="toolbar-spacer" />
        {!readOnly && (
          <>
            <button
              className="reader-ai-button"
              onClick={() => void analyze()}
              disabled={aiLoading || analysisActive}
              title="Analyze email with AI"
            >
              {aiLoading || analysisActive ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>{analysisActive ? "Analyzing" : aiState.analysis ? "Analyze again" : "Analyze"}</span>
            </button>
            <button
              className={`icon-button ${message.state.isStarred ? "active-star" : ""}`}
              title={message.state.isStarred ? "Remove star" : "Star message"}
              aria-label={message.state.isStarred ? "Remove star" : "Star message"}
              onClick={() => void onUpdateState({ isStarred: !message.state.isStarred })}
            >
              <Star size={18} fill={message.state.isStarred ? "currentColor" : "none"} />
            </button>
            <button
              className="icon-button"
              title={message.state.isRead ? "Mark unread" : "Mark read"}
              aria-label={message.state.isRead ? "Mark unread" : "Mark read"}
              onClick={() => void onUpdateState({ isRead: !message.state.isRead })}
            >
              {message.state.isRead ? <Mail size={18} /> : <MailOpen size={18} />}
            </button>
          </>
        )}
      </header>

      <div className="reader-scroll" ref={scrollRef}>
        <header className="message-header">
          <h1>{message.subject}</h1>
          <div className="sender-line">
            <span className="avatar large" aria-hidden="true">{initials(message.sender)}</span>
            <div className="sender-copy">
              <strong>{displayAddress(message.sender)}</strong>
              <span>{message.sender.address}</span>
              <span>
                to {message.to.map(displayAddress).join(", ") || "undisclosed recipients"}
                {message.cc.length > 0 ? ` · cc ${message.cc.map(displayAddress).join(", ")}` : ""}
              </span>
            </div>
            <time>{formatDateTime(message.receivedAt ?? message.sentAt)}</time>
          </div>

          {message.state.tags.length > 0 && (
            <div className="tag-row" aria-label="Message tags">
              {message.state.tags.map((tag) => (
                <span className="tag-chip" key={tag}><Tag size={12} />{tag}</span>
              ))}
            </div>
          )}
        </header>

        {(aiState.analysis || aiState.job || aiError) && (
          <AiAnalysisPanel
            state={aiState}
            loading={aiLoading}
            error={aiError}
            readOnly={readOnly}
            onCancel={() => void cancelAnalysis()}
          />
        )}

        <section className="message-body">
          {message.bodyHtml
            ? <EmailFrame message={message} api={api} onError={onError} />
            : <pre>{message.bodyText || "(This message has no text body.)"}</pre>}
        </section>

        {message.attachments.length > 0 && (
          <section className="attachments-section">
            <div className="attachments-heading">
              <Paperclip size={16} />
              <h2>{message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}</h2>
            </div>
            <div className="attachment-list">
              {message.attachments
                .filter((attachment) => attachment.disposition !== "inline" || !attachment.contentId)
                .map((attachment) => (
                  <AttachmentRow
                    key={attachment.id}
                    attachment={attachment}
                    api={api}
                    onError={onError}
                  />
                ))}
            </div>
          </section>
        )}

        {!readOnly && (
          <section className="local-notes">
            <div className="notes-heading">
              <div><Tag size={16} /><h2>Local notes</h2></div>
              {!editingNote ? (
                <button className="text-button" onClick={() => setEditingNote(true)}>Edit</button>
              ) : (
                <button className="icon-button subtle" onClick={() => setEditingNote(false)} title="Cancel editing" aria-label="Cancel editing">
                  <X size={16} />
                </button>
              )}
            </div>
            {editingNote ? (
              <div className="notes-editor">
                <label>
                  <span>Tags</span>
                  <input
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    placeholder="legal, follow-up, project"
                  />
                </label>
                <label>
                  <span>Note</span>
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={4}
                    placeholder="Add a private note"
                  />
                </label>
                <button className="primary-button compact" onClick={() => void saveMetadata()} disabled={saving}>
                  {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                  Save
                </button>
              </div>
            ) : (
              <p className={message.state.note ? "" : "muted"}>
                {message.state.note || "No note added."}
              </p>
            )}
          </section>
        )}
      </div>
    </article>
  );
}

function AiAnalysisPanel({
  state,
  loading,
  error,
  readOnly,
  onCancel
}: {
  state: AiMessageState;
  loading: boolean;
  error: string;
  readOnly: boolean;
  onCancel(): void;
}) {
  const { analysis, job } = state;
  const active = job?.status === "queued" || job?.status === "running";
  return (
    <section className="ai-analysis-panel" aria-label="AI analysis">
      <header>
        <div><BrainCircuit size={17} /><h2>AI analysis</h2></div>
        {active && !readOnly && (
          <button className="text-button" onClick={onCancel} disabled={loading}>Cancel</button>
        )}
      </header>
      {active && (
        <div className="ai-analysis-status" role="status">
          <LoaderCircle className="spin" size={17} />
          <span>{job.status === "queued" ? "Queued for local processing" : "Analyzing this email"}</span>
        </div>
      )}
      {job?.status === "failed" && (
        <div className="ai-analysis-error" role="alert"><CircleAlert size={17} /><span>{job.error || "Analysis failed"}</span></div>
      )}
      {job?.status === "cancelled" && !analysis && (
        <div className="ai-analysis-status"><CircleAlert size={17} /><span>Analysis cancelled</span></div>
      )}
      {error && <div className="ai-analysis-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
      {analysis && (
        <div className="ai-analysis-content">
          <p className="ai-summary">{analysis.summary}</p>
          <div className="ai-analysis-badges">
            <span className={`ai-priority priority-${analysis.priority}`}>{analysis.priority} priority</span>
            {analysis.categories.map((category) => <span className="tag-chip" key={category}>{category}</span>)}
          </div>
          <dl className="ai-analysis-facts">
            <div><dt>Action</dt><dd>{analysis.actionRequired ? analysis.actionSummary || "Action recommended" : "No action identified"}</dd></div>
            <div><dt>Spam risk</dt><dd>{percent(analysis.spamProbability)}</dd></div>
            <div><dt>Phishing risk</dt><dd>{percent(analysis.phishingProbability)}</dd></div>
            <div><dt>Confidence</dt><dd>{percent(analysis.confidence)}</dd></div>
          </dl>
          {analysis.signals.length > 0 && (
            <div className="ai-signals"><strong>Signals</strong><ul>{analysis.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul></div>
          )}
          <footer>{analysis.model} · AI output can be incorrect</footer>
        </div>
      )}
    </section>
  );
}

function EmailFrame({
  message,
  api,
  onError
}: {
  message: MessageDetail;
  api: ApiClient | null;
  onError(message: string): void;
}) {
  const [srcDoc, setSrcDoc] = useState("");
  const [mobileHtml, setMobileHtml] = useState("");
  const mobile = window.matchMedia("(max-width: 800px)").matches;

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const build = async () => {
      const cleaned = DOMPurify.sanitize(message.bodyHtml ?? "", {
        FORBID_TAGS: ["script", "form", "input", "button", "object", "embed", "base"],
        FORBID_ATTR: ["srcset", "formaction"]
      });
      const document = new DOMParser().parseFromString(cleaned, "text/html");
      for (const image of document.querySelectorAll("img")) {
        const source = image.getAttribute("src") ?? "";
        if (/^https?:/i.test(source) || source.startsWith("//")) {
          image.removeAttribute("src");
          image.setAttribute("alt", image.getAttribute("alt") || "Remote image blocked");
        }
      }
      if (mobile) {
        for (const styled of document.querySelectorAll("[style]")) {
          styled.removeAttribute("style");
        }
      }

      if (api) {
        const inlineAttachments = message.attachments.filter((attachment) => attachment.contentId);
        await Promise.all(inlineAttachments.map(async (attachment) => {
          try {
            const blob = await api.attachmentBlob(attachment.id);
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.push(objectUrl);
            const escapedId = CSS.escape(`cid:${attachment.contentId}`);
            for (const image of document.querySelectorAll(`img[src="${escapedId}"]`)) {
              image.setAttribute("src", objectUrl);
            }
            for (const image of document.querySelectorAll("img")) {
              if (image.getAttribute("src") === `cid:${attachment.contentId}`) {
                image.setAttribute("src", objectUrl);
              }
            }
          } catch (error) {
            onError(error instanceof Error ? error.message : "Inline image could not be loaded");
          }
        }));
      }

      if (!active) return;
      setMobileHtml(document.body.innerHTML);
      setSrcDoc(`<!doctype html>
        <html><head>
          <meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline';">
          <style>
            html{width:100%;min-height:100%;margin:0;padding:0;background:#fff}
            body{display:block;width:100%;min-height:1px;margin:0;padding:2px 1px 24px;box-sizing:border-box;background:#fff;color:#202622;font:15px/1.58 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}
            img{max-width:100%;height:auto} table{max-width:100%;border-collapse:collapse}
            a{color:#176747} blockquote{margin-left:0;padding-left:14px;border-left:3px solid #d9ded9;color:#5d665f}
            pre{white-space:pre-wrap} hr{border:0;border-top:1px solid #e0e4e0}
          </style>
        </head><body>${document.body.innerHTML}</body></html>`);
    };
    void build();
    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [api, message, mobile, onError]);

  return mobile ? (
    <div
      className="email-content"
      dangerouslySetInnerHTML={{ __html: mobileHtml }}
    />
  ) : (
    <iframe
      key={`${message.id}:${srcDoc.length}`}
      className="email-frame"
      title="Email body"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
    />
  );
}

function AttachmentRow({
  attachment,
  api,
  onError
}: {
  attachment: Attachment;
  api: ApiClient | null;
  onError(message: string): void;
}) {
  const [downloading, setDownloading] = useState(false);
  const Icon = useMemo(() => attachmentIcon(attachment), [attachment]);

  const download = async () => {
    if (!api) return;
    setDownloading(true);
    try {
      const blob = await api.attachmentBlob(attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Attachment could not be downloaded");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="attachment-row">
      <span className="attachment-file-icon"><Icon size={20} /></span>
      <span className="attachment-copy">
        <strong>{attachment.filename}</strong>
        <span>
          {formatBytes(attachment.sizeBytes)}
          {attachment.textStatus === "ocr_indexed" ? " · OCR" : ""}
        </span>
      </span>
      {attachment.textStatus === "indexed" || attachment.textStatus === "ocr_indexed"
        ? <Check className="indexed-check" size={15} aria-label="Search indexed" />
        : null}
      <button
        className="icon-button"
        onClick={() => void download()}
        disabled={downloading}
        title="Download attachment"
        aria-label={`Download ${attachment.filename}`}
      >
        {downloading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
      </button>
    </div>
  );
}

function attachmentIcon(attachment: Attachment) {
  const type = attachment.contentType;
  const name = attachment.filename.toLowerCase();
  if (type.startsWith("image/")) return FileImage;
  if (type.includes("spreadsheet") || /\.(xlsx?|csv|ods)$/.test(name)) return FileSpreadsheet;
  if (type.includes("zip") || /\.(zip|7z|rar|gz)$/.test(name)) return FileArchive;
  if (type.startsWith("text/") || /\.(pdf|docx?|rtf|md)$/.test(name)) return FileText;
  return File;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "AI action failed";
}
