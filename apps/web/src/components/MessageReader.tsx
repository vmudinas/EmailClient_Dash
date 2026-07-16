import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  Archive as ArchiveIcon,
  BrainCircuit,
  Check,
  CircleAlert,
  Download,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  FolderInput,
  ImageOff,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  Save,
  Sparkles,
  Star,
  Tag,
  X
} from "lucide-react";
import type {
  AiMessageState,
  Attachment,
  Folder,
  LocalMessageStatePatch,
  MessageDetail
} from "@email-client/shared";
import { displayAddress, formatBytes, formatDate, formatTimeOfDay, initials } from "../lib/format.js";
import type { ApiClient } from "../lib/api.js";

interface MessageReaderProps {
  message: MessageDetail | null;
  loading: boolean;
  readOnly: boolean;
  api: ApiClient | null;
  onMobileBack(): void;
  onUpdateState(patch: LocalMessageStatePatch): Promise<void>;
  onError(message: string): void;
  onReply(message: MessageDetail): void;
  onForward(message: MessageDetail): void;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onMove(messageId: string, folderId: string): Promise<void>;
  onArchive(message: MessageDetail): Promise<void>;
  moveBusy: boolean;
}

export function MessageReader({
  message,
  loading,
  readOnly,
  api,
  onMobileBack,
  onUpdateState,
  onError,
  onReply,
  onForward,
  onLoadFolders,
  onMove,
  onArchive,
  moveBusy
}: MessageReaderProps) {
  const [note, setNote] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiState, setAiState] = useState<AiMessageState>({ job: null, analysis: null });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
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
  const archived = /^(archive|archived)$/i.test(message.folderPath.split("/").at(-1) ?? "");

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
            <button className="icon-button" title="Reply" aria-label="Reply" onClick={() => onReply(message)}>
              <Reply size={18} />
            </button>
            <button className="icon-button" title="Forward" aria-label="Forward" onClick={() => onForward(message)}>
              <Forward size={18} />
            </button>
            {!archived && (
              <button
                className="reader-archive-button"
                title="Move to Archived locally"
                aria-label="Archive message"
                disabled={moveBusy}
                onClick={() => void onArchive(message)}
              >
                {moveBusy ? <LoaderCircle className="spin" size={16} /> : <ArchiveIcon size={16} />}
                <span>Archive</span>
              </button>
            )}
            <MoveToFolderMenu
              message={message}
              onLoadFolders={onLoadFolders}
              onMove={onMove}
              busy={moveBusy}
            />
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
            <span className="sender-time">
              <time>{formatDate(message.receivedAt ?? message.sentAt)}</time>
              <time className="sender-clock">{formatTimeOfDay(message.receivedAt ?? message.sentAt)}</time>
            </span>
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
                    onPreview={setPreviewAttachment}
                  />
                ))}
            </div>
          </section>
        )}

        <AttachmentPreviewDialog
          attachment={previewAttachment}
          api={api}
          onClose={() => setPreviewAttachment(null)}
          onError={onError}
        />

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

function MoveToFolderMenu({
  message,
  onLoadFolders,
  onMove,
  busy
}: {
  message: MessageDetail;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onMove(messageId: string, folderId: string): Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void onLoadFolders(message.archiveId)
      .then((loaded) => { if (active) setFolders(loaded); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, message.archiveId, onLoadFolders]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const candidates = folders.filter((folder) => folder.id !== message.folderId);

  return (
    <div className="move-menu" ref={containerRef}>
      <button
        className="icon-button"
        title="Move to folder"
        aria-label="Move to folder"
        onClick={() => setOpen((current) => !current)}
        disabled={busy}
      >
        <FolderInput size={18} />
      </button>
      {open && (
        <div className="move-menu-panel" role="menu">
          {loading ? (
            <div className="move-menu-loading"><LoaderCircle className="spin" size={16} /></div>
          ) : candidates.length === 0 ? (
            <div className="move-menu-empty">No other mailboxes</div>
          ) : (
            candidates.map((folder) => (
              <button
                key={folder.id}
                className="move-menu-item"
                role="menuitem"
                disabled={busy}
                onClick={() => { setOpen(false); void onMove(message.id, folder.id); }}
              >
                {folder.path}
              </button>
            ))
          )}
        </div>
      )}
    </div>
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
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  const [hasBlockedImages, setHasBlockedImages] = useState(false);
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
      let blockedImageFound = false;
      for (const image of document.querySelectorAll("img")) {
        // data-remote-src is set by the server-side sanitizer for a blocked remote image;
        // fall back to blocking any raw http(s)/protocol-relative src as a safety net for
        // messages stored before that attribute existed.
        const remoteSrc = image.getAttribute("data-remote-src");
        const currentSrc = image.getAttribute("src") ?? "";
        const isRemote = Boolean(remoteSrc) || /^https?:/i.test(currentSrc) || currentSrc.startsWith("//");
        if (!isRemote) continue;
        blockedImageFound = true;
        if (showRemoteImages && remoteSrc) {
          image.setAttribute("src", remoteSrc);
        } else {
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
      setHasBlockedImages(blockedImageFound && !showRemoteImages);
      setMobileHtml(document.body.innerHTML);
      const imgSrc = showRemoteImages ? "data: blob: https: http:" : "data: blob:";
      setSrcDoc(`<!doctype html>
        <html><head>
          <meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline';">
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
  }, [api, message, mobile, onError, showRemoteImages]);

  return (
    <>
      {hasBlockedImages && (
        <div className="image-block-banner">
          <ImageOff size={15} />
          <span>Images are blocked to protect your privacy.</span>
          <button className="text-button" onClick={() => setShowRemoteImages(true)}>Show images</button>
        </div>
      )}
      {mobile ? (
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
      )}
    </>
  );
}

function AttachmentRow({
  attachment,
  api,
  onError,
  onPreview
}: {
  attachment: Attachment;
  api: ApiClient | null;
  onError(message: string): void;
  onPreview(attachment: Attachment): void;
}) {
  const [downloading, setDownloading] = useState(false);
  const Icon = useMemo(() => attachmentIcon(attachment), [attachment]);
  const previewable = isPreviewableAttachment(attachment);

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
      <span className="attachment-actions">
        {previewable && (
          <button
            className="icon-button"
            onClick={() => onPreview(attachment)}
            title="Preview attachment"
            aria-label={`Preview ${attachment.filename}`}
          >
            <Eye size={17} />
          </button>
        )}
        <button
          className="icon-button"
          onClick={() => void download()}
          disabled={downloading}
          title="Download attachment"
          aria-label={`Download ${attachment.filename}`}
        >
          {downloading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
        </button>
      </span>
    </div>
  );
}

function AttachmentPreviewDialog({
  attachment,
  api,
  onClose,
  onError
}: {
  attachment: Attachment | null;
  api: ApiClient | null;
  onClose(): void;
  onError(message: string): void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!attachment || !api) {
      setObjectUrl(null);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    setLoading(true);
    void api.attachmentBlob(attachment.id)
      .then((blob) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch((error) => {
        onError(error instanceof Error ? error.message : "Attachment could not be loaded");
        onClose();
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment?.id, api]);

  if (!attachment) return null;
  const isImage = attachment.contentType.startsWith("image/");

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog attachment-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><Eye size={20} /><h2 id="attachment-preview-title">{attachment.filename}</h2></div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body attachment-preview-body">
          {loading || !objectUrl ? (
            <div className="attachment-preview-loading"><LoaderCircle className="spin" size={22} /></div>
          ) : isImage ? (
            <img className="attachment-preview-image" src={objectUrl} alt={attachment.filename} />
          ) : (
            <iframe className="attachment-preview-frame" title={attachment.filename} src={objectUrl} />
          )}
        </div>
      </section>
    </div>
  );
}

function isPreviewableAttachment(attachment: Attachment): boolean {
  const type = attachment.contentType;
  const name = attachment.filename.toLowerCase();
  return type.startsWith("image/") || type === "application/pdf" || name.endsWith(".pdf");
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
