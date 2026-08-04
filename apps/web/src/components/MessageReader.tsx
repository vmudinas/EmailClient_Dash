import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  Archive as ArchiveIcon,
  BellPlus,
  BrainCircuit,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  ClipboardCopy,
  ContactRound,
  Download,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileDown,
  Forward,
  Folder as FolderIcon,
  FolderInput,
  ImageOff,
  LoaderCircle,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  Save,
  ShieldBan,
  Sparkles,
  Star,
  Tag,
  X
} from "lucide-react";
import type {
  AiJob,
  AiMessageState,
  Attachment,
  EmailDraft,
  Folder,
  GmailConnection,
  LocalMessageStatePatch,
  MessageActionSuggestion,
  MessageAnalysis,
  MessageDetail,
  MessageThread
} from "@email-client/shared";
import { displayAddress, formatBytes, formatDate, formatTimeOfDay, initials } from "../lib/format.js";
import { useMediaQuery } from "../lib/use-media-query.js";
import type { ApiClient } from "../lib/api.js";
import { MessageActionDialog } from "./MessageActionDialog.js";
import { AiDraftReplyDialog } from "./AiDraftReplyDialog.js";
import { FollowUpDialog } from "./FollowUpDialog.js";

interface MessageReaderProps {
  message: MessageDetail | null;
  loading: boolean;
  readOnly: boolean;
  api: ApiClient | null;
  connections: GmailConnection[];
  onMobileBack(): void;
  onUpdateState(patch: LocalMessageStatePatch): Promise<void>;
  onError(message: string): void;
  onReply(message: MessageDetail): void;
  onForward(message: MessageDetail): void;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onMove(messageId: string, folderId: string): Promise<void>;
  onArchive(message: MessageDetail): Promise<void>;
  onSpamSender(message: MessageDetail): Promise<void>;
  onOpenDraft(draft: EmailDraft): void;
  onIndicatorsChange(messageId: string, patch: { hasAiAnalysis?: boolean; hasCalendarEvent?: boolean; hasPendingFollowUp?: boolean }): void;
  moveBusy: boolean;
  spamBusy: boolean;
}

export function MessageReader({
  message,
  loading,
  readOnly,
  api,
  connections,
  onMobileBack,
  onUpdateState,
  onError,
  onReply,
  onForward,
  onLoadFolders,
  onMove,
  onArchive,
  onSpamSender,
  onOpenDraft,
  onIndicatorsChange,
  moveBusy,
  spamBusy
}: MessageReaderProps) {
  const [note, setNote] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiState, setAiState] = useState<AiMessageState>({ job: null, analysis: null });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [actionSuggestion, setActionSuggestion] = useState<MessageActionSuggestion | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [draftJob, setDraftJob] = useState<AiJob | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledDraftJobRef = useRef<string | null>(null);

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
    setActionSuggestion(null);
    setActionNotice("");
    setDraftDialogOpen(false);
    setFollowUpDialogOpen(false);
    setThread(null);
    setDraftJob(null);
    handledDraftJobRef.current = null;
    if (!api || !message?.id) return () => { active = false; };
    setAiLoading(true);
    void api.getMessageAiState(message.id)
      .then((state) => {
        if (!active) return;
        const activeDraft = state.job?.task === "draft_reply"
          && (state.job.status === "queued" || state.job.status === "running")
          ? state.job
          : null;
        if (activeDraft) setDraftJob(activeDraft);
        setAiState({
          ...state,
          job: state.job?.task === "analyze" ? state.job : null
        });
      })
      .catch((error) => { if (active) setAiError(errorText(error)); })
      .finally(() => { if (active) setAiLoading(false); });
    const threadRequest = typeof api.getMessageThread === "function"
      ? api.getMessageThread(message.id)
      : Promise.resolve(null);
    void threadRequest
      .then((value) => { if (active) setThread(value); })
      .catch(() => { if (active) setThread(null); });
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

  useEffect(() => {
    if (message?.id && aiState.analysis) {
      onIndicatorsChange(message.id, { hasAiAnalysis: true });
    }
  }, [message?.id, aiState.analysis?.id, onIndicatorsChange]);

  useEffect(() => {
    if (!api || !draftJob || !message?.id) return;
    let active = true;

    const handleJob = async (job: AiJob) => {
      if (!active) return;
      setDraftJob(job);
      if (job.status === "queued" || job.status === "running") return;
      if (handledDraftJobRef.current === job.id) return;
      handledDraftJobRef.current = job.id;
      if (job.status === "completed") {
        const drafts = await api.listDrafts();
        if (!active) return;
        const draft = drafts.find((entry) => entry.sourceMessageId === job.messageId) ?? null;
        if (draft) {
          setActionNotice("AI reply draft created. Review it before sending.");
          onOpenDraft(draft);
        } else {
          setActionNotice("AI finished, but no reply draft was created.");
        }
      } else if (job.status === "failed") {
        setAiError(job.error || "AI draft generation failed");
      } else {
        setActionNotice("AI draft generation was cancelled.");
      }
      setDraftJob(null);
    };

    const refresh = async () => {
      try {
        await handleJob(await api.getAiJob(draftJob.id));
      } catch (error) {
        if (active) {
          setAiError(errorText(error));
          setDraftJob(null);
        }
      }
    };

    void refresh();
    if (draftJob.status !== "queued" && draftJob.status !== "running") {
      return () => { active = false; };
    }
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, draftJob?.id, draftJob?.status, message?.id, onOpenDraft]);


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

  const suggestAction = async () => {
    if (!api || !message) return;
    setActionLoading(true);
    setAiError("");
    setActionNotice("");
    try {
      const suggestion = await api.suggestMessageAction(message.id, {
        now: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      });
      setActionSuggestion(suggestion);
    } catch (error) {
      setAiError(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const startDraft = (result: { job: AiJob | null; draft: EmailDraft | null }) => {
    setAiError("");
    handledDraftJobRef.current = null;
    if (result.draft) {
      setActionNotice("A reply draft already exists for this conversation.");
      onOpenDraft(result.draft);
      return;
    }
    if (result.job) {
      setDraftJob(result.job);
      setActionNotice("AI reply draft queued. It will open for review when ready.");
    }
  };

  const analysisActive = aiState.job?.status === "queued" || aiState.job?.status === "running";
  const draftActive = draftJob?.status === "queued" || draftJob?.status === "running";
  const archived = /^(archive|archived)$/i.test(message.folderPath.split("/").at(-1) ?? "");

  return (
    <article className="reader-pane" aria-label={message.subject}>
      <header className="reader-toolbar">
        <button className="icon-button reader-back-button" onClick={onMobileBack} title="Back to messages" aria-label="Back to messages">
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
            <button
              className="icon-button spam-sender-button"
              title="Always send this sender to Spam"
              aria-label="Always send sender to Spam"
              disabled={spamBusy || !message.sender.address.trim()}
              onClick={() => void onSpamSender(message)}
            >
              {spamBusy ? <LoaderCircle className="spin" size={17} /> : <ShieldBan size={18} />}
            </button>
            {!archived && (
              <button
                className="reader-archive-button"
                title="Move to Archived"
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
            thread={thread}
            loading={aiLoading}
            error={aiError}
            readOnly={readOnly}
            onCancel={() => void cancelAnalysis()}
            actions={!readOnly && aiState.analysis ? (
              <AiMessageActions
                api={api}
                message={message}
                analysis={aiState.analysis}
                connections={connections}
                drafting={draftActive}
                planning={actionLoading}
                analysisBusy={analysisActive}
                moveBusy={moveBusy}
                spamBusy={spamBusy}
                onDraft={() => {
                  if (connections.some((connection) => connection.canSend)) setDraftDialogOpen(true);
                  else onError("Connect or reauthorize Gmail with send permission to create a draft.");
                }}
                onPlan={() => void suggestAction()}
                onFollowUp={() => setFollowUpDialogOpen(true)}
                onReply={() => onReply(message)}
                onForward={() => onForward(message)}
                onLoadFolders={onLoadFolders}
                onMove={onMove}
                onArchive={() => void onArchive(message)}
                onSpam={() => void onSpamSender(message)}
                onNotice={setActionNotice}
                onError={onError}
              />
            ) : null}
          />
        )}

        {actionNotice && <div className="message-action-notice" role="status"><Check size={15} />{actionNotice}</div>}

        <section className="message-body">
          {message.bodyHtml
            ? <EmailFrame message={message} api={api} onError={onError} />
            : <pre>{message.bodyText || "(This message has no text body.)"}</pre>}
        </section>

        {message.attachments.length > 0 && (
          <section className="attachments-section">
            <div className="attachments-heading">
              <Paperclip size={16} />
              <h2>{attachmentSectionLabel(message.attachments)}</h2>
            </div>
            <div className="attachment-list">
              {message.attachments.map((attachment) => (
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

        {api && actionSuggestion && (
          <MessageActionDialog
            api={api}
            messageId={message.id}
            suggestion={actionSuggestion}
            connections={connections}
            onClose={() => setActionSuggestion(null)}
            onCreated={(notice, action) => {
              setActionSuggestion(null);
              setActionNotice(notice);
              if (action === "calendar_event") {
                onIndicatorsChange(message.id, { hasCalendarEvent: true });
              }
            }}
            onError={setAiError}
          />
        )}

        {api && (
          <AiDraftReplyDialog
            open={draftDialogOpen}
            api={api}
            messageId={message.id}
            archiveId={message.archiveId}
            connections={connections}
            onClose={() => setDraftDialogOpen(false)}
            onStarted={startDraft}
          />
        )}

        {api && (
          <FollowUpDialog
            open={followUpDialogOpen}
            api={api}
            messageId={message.id}
            subject={message.subject}
            suggestedNote={aiState.analysis?.actionSummary}
            onClose={() => setFollowUpDialogOpen(false)}
            onCreated={() => {
              setActionNotice("Follow-up saved for this conversation.");
              onIndicatorsChange(message.id, { hasPendingFollowUp: true });
            }}
          />
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
  thread,
  loading,
  error,
  readOnly,
  onCancel,
  actions
}: {
  state: AiMessageState;
  thread: MessageThread | null;
  loading: boolean;
  error: string;
  readOnly: boolean;
  onCancel(): void;
  actions: ReactNode;
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
          <span>{job.status === "queued" ? "Queued for local processing" : "Analyzing this conversation"}</span>
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
          {((analysis.threadMessageCount ?? 1) > 1 || (thread?.totalMessages ?? 0) > 1) && (
            <details className="ai-thread-context">
              <summary>{analysis.threadMessageCount ?? thread?.totalMessages ?? 1} messages analyzed in this conversation</summary>
              <ol>
                {thread?.messages.map((entry) => (
                  <li key={entry.id} className={entry.id === state.analysis?.messageId ? "selected" : ""}>
                    <span>{displayAddress(entry.sender)}</span><strong>{entry.subject}</strong><time>{formatDate(entry.receivedAt ?? entry.sentAt)}</time>
                  </li>
                ))}
              </ol>
            </details>
          )}
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
          {actions}
          <footer>
            <span>{analysis.model} · AI output can be incorrect</span>
          </footer>
        </div>
      )}
    </section>
  );
}

function AiMessageActions({
  api,
  message,
  analysis,
  connections,
  drafting,
  planning,
  analysisBusy,
  moveBusy,
  spamBusy,
  onDraft,
  onPlan,
  onFollowUp,
  onReply,
  onForward,
  onLoadFolders,
  onMove,
  onArchive,
  onSpam,
  onNotice,
  onError
}: {
  api: ApiClient | null;
  message: MessageDetail;
  analysis: MessageAnalysis;
  connections: GmailConnection[];
  drafting: boolean;
  planning: boolean;
  analysisBusy: boolean;
  moveBusy: boolean;
  spamBusy: boolean;
  onDraft(): void;
  onPlan(): void;
  onFollowUp(): void;
  onReply(): void;
  onForward(): void;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onMove(messageId: string, folderId: string): Promise<void>;
  onArchive(): void;
  onSpam(): void;
  onNotice(message: string): void;
  onError(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"actions" | "folders">("actions");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const downloadableAttachments = message.attachments;
  const unsubscribeUrl = extractUnsubscribeUrl(message.headers);
  const archived = /^(archive|archived)$/i.test(message.folderPath.split("/").at(-1) ?? "");
  const canSend = connections.some((connection) => connection.canSend);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const close = () => {
    setOpen(false);
    setView("actions");
  };

  const copy = async (value: string, notice: string) => {
    try {
      await copyText(value);
      onNotice(notice);
      close();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Text could not be copied");
    }
  };

  const showFolders = async () => {
    setView("folders");
    setFoldersLoading(true);
    try {
      setFolders(await onLoadFolders(message.archiveId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Mailboxes could not be loaded");
      setView("actions");
    } finally {
      setFoldersLoading(false);
    }
  };

  const saveAllAttachments = async () => {
    if (!api || downloadableAttachments.length === 0) return;
    setAttachmentsBusy(true);
    try {
      for (const attachment of downloadableAttachments) {
        downloadBlob(await api.attachmentBlob(attachment.id), attachment.filename);
        await new Promise((resolve) => window.setTimeout(resolve, 75));
      }
      onNotice(`Saved ${downloadableAttachments.length} attachment${downloadableAttachments.length === 1 ? "" : "s"}.`);
      close();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Attachments could not be saved");
    } finally {
      setAttachmentsBusy(false);
    }
  };

  const addContact = () => {
    const name = message.sender.name?.trim() || message.sender.address;
    const card = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${escapeVcard(name)}`,
      `EMAIL;TYPE=INTERNET:${escapeVcard(message.sender.address)}`,
      "END:VCARD",
      ""
    ].join("\r\n");
    downloadBlob(new Blob([card], { type: "text/vcard;charset=utf-8" }), `${safeContactFilename(name)}.vcf`);
    onNotice(`Contact card created for ${name}.`);
    close();
  };

  const openUnsubscribe = () => {
    if (!unsubscribeUrl || !window.confirm("Open the sender's unsubscribe link for review?")) return;
    window.open(unsubscribeUrl, "_blank", "noopener,noreferrer");
    onNotice("Unsubscribe link opened. Review the destination before confirming.");
    close();
  };

  return (
    <div className="ai-message-actions" aria-label="AI suggested actions">
      <button
        type="button"
        className={`${analysis.draftRecommended ? "primary-button" : "secondary-button"} compact`}
        disabled={drafting || analysisBusy}
        onClick={onDraft}
        title={canSend ? "Generate a reviewable AI reply draft" : "Connect Gmail with send permission first"}
      >
        {drafting ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
        {drafting ? "Drafting" : "Draft reply"}
      </button>
      <button
        type="button"
        className="secondary-button compact"
        aria-label="Plan event or to-do"
        disabled={planning || analysisBusy}
        onClick={onPlan}
      >
        {planning ? <LoaderCircle className="spin" size={15} /> : <CalendarPlus size={15} />}
        {planning ? "Finding dates" : "Plan"}
      </button>
      <button type="button" className="secondary-button compact" onClick={onFollowUp} disabled={analysisBusy}>
        <BellPlus size={15} /> Follow up
      </button>
      <div className="ai-more-menu" ref={containerRef}>
        <button
          type="button"
          className="secondary-button compact"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setView("actions");
            setOpen((current) => !current);
          }}
        >
          <MoreHorizontal size={15} /> More <ChevronDown size={13} />
        </button>
        {open && (
          <div className="ai-more-panel" role="menu">
            {view === "folders" ? (
              <>
                <button className="ai-more-back" role="menuitem" onClick={() => setView("actions")}>
                  <ChevronLeft size={15} /> Back to actions
                </button>
                {foldersLoading ? (
                  <div className="move-menu-loading"><LoaderCircle className="spin" size={16} /></div>
                ) : folders.filter((folder) => folder.id !== message.folderId).length === 0 ? (
                  <div className="move-menu-empty">No other mailboxes</div>
                ) : folders.filter((folder) => folder.id !== message.folderId).map((folder) => (
                  <button
                    key={folder.id}
                    className="ai-more-item folder"
                    role="menuitem"
                    disabled={moveBusy}
                    onClick={() => {
                      close();
                      void onMove(message.id, folder.id);
                    }}
                  >
                    <FolderIcon size={16} />
                    <span><strong>{folder.name}</strong><small>{folder.path}</small></span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button className="ai-more-item" role="menuitem" onClick={() => { close(); onReply(); }}>
                  <Reply size={16} /><span><strong>Reply manually</strong><small>Open an editable reply</small></span>
                </button>
                <button className="ai-more-item" role="menuitem" onClick={() => { close(); onForward(); }}>
                  <Forward size={16} /><span><strong>Forward</strong><small>Add context before sending</small></span>
                </button>
                <button className="ai-more-item" role="menuitem" disabled={analysisBusy} onClick={() => { close(); onFollowUp(); }}>
                  <BellPlus size={16} /><span><strong>Create follow-up</strong><small>Remind me until this thread is answered</small></span>
                </button>
                <button className="ai-more-item" role="menuitem" onClick={() => void copy(analysis.summary, "AI summary copied.")}>
                  <ClipboardCopy size={16} /><span><strong>Copy summary</strong><small>Copy the AI synopsis</small></span>
                </button>
                {analysis.actionRequired && analysis.actionSummary && (
                  <button className="ai-more-item" role="menuitem" onClick={() => void copy(analysis.actionSummary!, "Recommended action copied.")}>
                    <Check size={16} /><span><strong>Copy action item</strong><small>{analysis.actionSummary}</small></span>
                  </button>
                )}
                {downloadableAttachments.length > 0 && (
                  <button className="ai-more-item" role="menuitem" disabled={attachmentsBusy} onClick={() => void saveAllAttachments()}>
                    {attachmentsBusy ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}
                    <span><strong>Save all attachments</strong><small>{downloadableAttachments.length} file{downloadableAttachments.length === 1 ? "" : "s"}</small></span>
                  </button>
                )}
                {message.sender.address.includes("@") && (
                  <button className="ai-more-item" role="menuitem" onClick={addContact}>
                    <ContactRound size={16} /><span><strong>Add sender to contacts</strong><small>Download a vCard</small></span>
                  </button>
                )}
                {unsubscribeUrl && (
                  <button className="ai-more-item" role="menuitem" onClick={openUnsubscribe}>
                    <MailOpen size={16} /><span><strong>Unsubscribe</strong><small>Open the sender-provided link</small></span>
                  </button>
                )}
                <button className="ai-more-item" role="menuitem" onClick={() => void showFolders()}>
                  <FolderInput size={16} /><span><strong>Move to folder</strong><small>Choose a mailbox</small></span>
                </button>
                {!archived && (
                  <button className="ai-more-item" role="menuitem" disabled={moveBusy} onClick={() => { close(); onArchive(); }}>
                    <ArchiveIcon size={16} /><span><strong>Archive</strong><small>Move out of Inbox</small></span>
                  </button>
                )}
                <button className="ai-more-item danger" role="menuitem" disabled={spamBusy} onClick={() => { close(); onSpam(); }}>
                  <ShieldBan size={16} /><span><strong>Always send sender to Spam</strong><small>Apply the persistent sender rule</small></span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
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
                aria-label={folder.path}
                title={folder.path}
                disabled={busy}
                onClick={() => { setOpen(false); void onMove(message.id, folder.id); }}
              >
                <FolderIcon size={16} aria-hidden="true" />
                <span className="move-menu-item-copy">
                  <strong>{folder.name}</strong>
                  <small>{folder.path}</small>
                </span>
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
  const [remoteImagesMessageId, setRemoteImagesMessageId] = useState<string | null>(null);
  const [hasBlockedImages, setHasBlockedImages] = useState(false);
  const [hasRemoteImages, setHasRemoteImages] = useState(false);
  const [trustedSenders, setTrustedSenders] = useState<string[]>(readTrustedRemoteImageSenders);
  const mobile = useMediaQuery("(max-width: 800px)");
  const senderAddress = message.sender.address.trim().toLowerCase();
  const senderTrusted = Boolean(senderAddress) && trustedSenders.includes(senderAddress);
  const showRemoteImages = remoteImagesMessageId === message.id || senderTrusted;

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
        const remoteSource = remoteSrc
          ?? (/^https?:/i.test(currentSrc) ? currentSrc : currentSrc.startsWith("//") ? `https:${currentSrc}` : null);
        if (!remoteSource) continue;
        blockedImageFound = true;
        if (showRemoteImages) {
          image.setAttribute("src", remoteSource);
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

      const commitDocument = () => {
        if (!active) return;
        const bodyHtml = document.body.innerHTML;
        setHasRemoteImages(blockedImageFound);
        setHasBlockedImages(blockedImageFound && !showRemoteImages);
        setMobileHtml(bodyHtml);
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
          </head><body>${bodyHtml}</body></html>`);
      };

      // Render the message text immediately. Inline images can fill in as their
      // attachment downloads complete instead of blocking the whole email.
      commitDocument();

      if (api) {
        const inlineAttachments = message.attachments.filter((attachment) => attachment.contentId);
        await Promise.all(inlineAttachments.map(async (attachment) => {
          try {
            const blob = await api.attachmentBlob(attachment.id);
            if (!active) return;
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

      commitDocument();
    };
    void build();
    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [api, message, mobile, onError, showRemoteImages]);

  const alwaysShowForSender = () => {
    if (!senderAddress) return;
    const next = [...new Set([...trustedSenders, senderAddress])].sort();
    writeTrustedRemoteImageSenders(next);
    setTrustedSenders(next);
    setRemoteImagesMessageId(message.id);
  };

  const blockSenderImages = () => {
    const next = trustedSenders.filter((address) => address !== senderAddress);
    writeTrustedRemoteImageSenders(next);
    setTrustedSenders(next);
    setRemoteImagesMessageId(null);
  };

  return (
    <>
      {hasBlockedImages && (
        <div className="image-block-banner" role="status">
          <ImageOff size={15} />
          <span>Remote images are blocked because they can notify the sender when you open this email.</span>
          <button type="button" className="secondary-button compact image-block-show" onClick={() => setRemoteImagesMessageId(message.id)}>Show images</button>
          {senderAddress && <button type="button" className="secondary-button compact image-block-show" onClick={alwaysShowForSender}>Always for sender</button>}
        </div>
      )}
      {hasRemoteImages && senderTrusted && !hasBlockedImages && (
        <div className="image-block-banner images-allowed" role="status">
          <Eye size={15} />
          <span>Remote images are shown automatically for {message.sender.name || message.sender.address} on this device.</span>
          <button type="button" className="text-button" onClick={blockSenderImages}>Block images</button>
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
      downloadBlob(await api.attachmentBlob(attachment.id), attachment.filename);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Attachment could not be downloaded");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`attachment-row${attachment.disposition === "inline" ? " is-inline" : ""}`}>
      <button
        type="button"
        className="attachment-open"
        onClick={() => previewable ? onPreview(attachment) : void download()}
        disabled={!api || downloading}
        title={previewable ? `Preview ${attachment.filename}` : `Download ${attachment.filename}`}
      >
        <span className="attachment-file-icon"><Icon size={20} /></span>
        <span className="attachment-copy">
          <strong>{attachment.filename}</strong>
          <span>
            {formatBytes(attachment.sizeBytes)}
            {attachment.disposition === "inline" ? " · Inline" : ""}
            {attachment.textStatus === "ocr_indexed" ? " · OCR" : ""}
          </span>
        </span>
      </button>
      {attachment.textStatus === "indexed" || attachment.textStatus === "ocr_indexed"
        ? <Check className="indexed-check" size={15} aria-label="Search indexed" />
        : null}
      <span className="attachment-actions">
        {previewable && (
          <button
            type="button"
            className="secondary-button compact attachment-action"
            onClick={() => onPreview(attachment)}
            title="Preview attachment"
            aria-label={`Preview ${attachment.filename}`}
          >
            <Eye size={16} /><span>Preview</span>
          </button>
        )}
        <button
          type="button"
          className="secondary-button compact attachment-action"
          onClick={() => void download()}
          disabled={!api || downloading}
          title="Download attachment"
          aria-label={`Download ${attachment.filename}`}
        >
          {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}<span>Download</span>
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
  const [downloading, setDownloading] = useState(false);

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
  const isImage = isImageAttachment(attachment);
  const download = async () => {
    if (!api) return;
    setDownloading(true);
    try {
      downloadBlob(await api.attachmentBlob(attachment.id), attachment.filename);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Attachment could not be downloaded");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog attachment-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><Eye size={20} /><h2 id="attachment-preview-title">{attachment.filename}</h2></div>
          <div className="attachment-preview-header-actions">
            <button type="button" className="secondary-button compact" disabled={!api || downloading} onClick={() => void download()}>
              {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Download
            </button>
            <button type="button" className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body attachment-preview-body">
          {loading || !objectUrl ? (
            <div className="attachment-preview-loading"><LoaderCircle className="spin" size={22} /></div>
          ) : isImage ? (
            <img className="attachment-preview-image" src={objectUrl} alt={attachment.filename} />
          ) : (
            <iframe className="attachment-preview-frame" title={attachment.filename} src={objectUrl} sandbox="" referrerPolicy="no-referrer" />
          )}
        </div>
      </section>
    </div>
  );
}

function isPreviewableAttachment(attachment: Attachment): boolean {
  const type = attachment.contentType.toLowerCase();
  const name = attachment.filename.toLowerCase();
  return isImageAttachment(attachment)
    || type.startsWith("text/")
    || type.startsWith("application/json")
    || type.startsWith("application/xml")
    || /\.(pdf|txt|text|log|md|csv|json|xml)$/.test(name);
}

function attachmentSectionLabel(attachments: Attachment[]): string {
  const fileCount = attachments.filter(
    (attachment) => attachment.disposition !== "inline" || !attachment.contentId
  ).length;
  const inlineCount = attachments.length - fileCount;
  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} attachment${fileCount === 1 ? "" : "s"}`);
  if (inlineCount > 0) parts.push(`${inlineCount} inline image${inlineCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function isImageAttachment(attachment: Attachment): boolean {
  return attachment.contentType.toLowerCase().startsWith("image/")
    || /\.(bmp|gif|jpe?g|png|webp)$/i.test(attachment.filename);
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

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") ?? false;
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const TRUSTED_REMOTE_IMAGE_SENDERS_KEY = "archive-mail.trusted-remote-image-senders";

function readTrustedRemoteImageSenders(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRUSTED_REMOTE_IMAGE_SENDERS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function writeTrustedRemoteImageSenders(senders: string[]): void {
  try {
    window.localStorage.setItem(TRUSTED_REMOTE_IMAGE_SENDERS_KEY, JSON.stringify(senders));
  } catch {
    // A blocked storage API should not prevent the one-time image reveal.
  }
}

function extractUnsubscribeUrl(headers: Record<string, string>): string | null {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "list-unsubscribe")?.[1];
  if (!value) return null;
  const candidates = [...value.matchAll(/<([^>]+)>/g)].map((match) => match[1]!.trim());
  if (candidates.length === 0) candidates.push(...value.split(",").map((entry) => entry.trim()));
  return candidates.find((candidate) => /^https:\/\//i.test(candidate))
    ?? candidates.find((candidate) => /^mailto:/i.test(candidate))
    ?? null;
}

function escapeVcard(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
}

function safeContactFilename(value: string): string {
  const safe = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return safe || "contact";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "AI action failed";
}
