import DOMPurify from "dompurify";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import {
  Archive,
  ArrowLeft,
  BellRing,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  CircleUserRound,
  HeartPulse,
  Inbox,
  Info,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  PackageSearch,
  ReceiptText,
  Reply,
  SearchX,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
  X
} from "lucide-react";
import type {
  InboxCategory,
  InboxCategoryCounts,
  MessageSummary,
  SearchHit
} from "@email-client/shared";
import { displayAddress, formatDate, formatTimeOfDay, initials } from "../lib/format.js";

export interface MessageListItem {
  message: MessageSummary;
  hit?: SearchHit;
}

interface MessageListProps {
  items: MessageListItem[];
  selectedMessageId: string | null;
  title: string;
  loading: boolean;
  searching: boolean;
  hasMore: boolean;
  readOnly: boolean;
  onSelect(message: MessageSummary): void;
  onDragStart(message: MessageSummary): void;
  onDragEnd(): void;
  onLoadMore(): void;
  onMobileBack(): void;
  inboxCategories?: {
    active: InboxCategory;
    counts: InboxCategoryCounts;
    onSelect(category: InboxCategory): void;
  } | null;
  selectedIds: Set<string>;
  onToggleSelect(messageId: string): void;
  onToggleSelectAll(): void;
  onClearSelection(): void;
  bulkBusy: boolean;
  onBulkDelete(): void;
  onBulkArchive(): void;
  onBulkSpam(): void;
  actionBusy: boolean;
  onArchive(message: MessageSummary): void;
  onSpam(message: MessageSummary): void;
  onToggleRead(message: MessageSummary): void;
}

const CATEGORY_TABS: Array<{
  id: InboxCategory;
  label: string;
  icon: typeof Inbox;
}> = [
  { id: "primary", label: "Primary", icon: Inbox },
  { id: "promotions", label: "Promotions", icon: Tag },
  { id: "social", label: "Social", icon: CircleUserRound },
  { id: "updates", label: "Updates", icon: Info },
  { id: "bills", label: "Bills", icon: ReceiptText },
  { id: "medical", label: "Medical", icon: HeartPulse },
  { id: "mail_tracking", label: "Mail/Tracking", icon: PackageSearch }
];

export function MessageList({
  items,
  selectedMessageId,
  title,
  loading,
  searching,
  hasMore,
  readOnly,
  onSelect,
  onDragStart,
  onDragEnd,
  onLoadMore,
  onMobileBack,
  inboxCategories,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onClearSelection,
  bulkBusy,
  onBulkDelete,
  onBulkArchive,
  onBulkSpam,
  actionBusy,
  onArchive,
  onSpam,
  onToggleRead
}: MessageListProps) {
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(null);
  const selectedCount = selectedIds.size;
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.message.id));
  return (
    <section className="message-list-pane" aria-label="Messages">
      <header className="pane-header message-list-header">
        {selectedCount > 0 ? (
          <div className="message-bulk-toolbar">
            <button className="icon-button" onClick={onClearSelection} title="Clear selection" aria-label="Clear selection" disabled={bulkBusy}>
              <X size={17} />
            </button>
            <span>{selectedCount.toLocaleString()} selected</span>
            <div className="message-bulk-actions">
              <button className="icon-button" onClick={onBulkArchive} disabled={bulkBusy} title="Move to Archive" aria-label="Move selected to Archive">
                <Archive size={17} />
              </button>
              <button className="icon-button" onClick={onBulkSpam} disabled={bulkBusy} title="Move to Spam" aria-label="Move selected to Spam">
                <ShieldAlert size={17} />
              </button>
              <button className="icon-button danger" onClick={onBulkDelete} disabled={bulkBusy} title="Delete" aria-label="Delete selected">
                {bulkBusy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button className="icon-button mobile-only" onClick={onMobileBack} title="Back to folders" aria-label="Back to folders">
              <ArrowLeft size={18} />
            </button>
            {!readOnly && items.length > 0 && (
              <input
                type="checkbox"
                className="message-select-all"
                checked={allVisibleSelected}
                onChange={onToggleSelectAll}
                title={allVisibleSelected ? "Deselect all" : "Select all shown"}
                aria-label={allVisibleSelected ? "Deselect all shown messages" : "Select all shown messages"}
              />
            )}
            <div>
              <h2>{title}</h2>
              <span>{items.length.toLocaleString()}{hasMore ? "+" : ""} shown</span>
            </div>
          </>
        )}
      </header>

      {inboxCategories && (
        <nav className="inbox-category-tabs" aria-label="Inbox categories">
          {CATEGORY_TABS.map((category) => {
            const Icon = category.icon;
            return (
              <button
                className={`inbox-category-tab ${category.id} ${inboxCategories.active === category.id ? "active" : ""}`}
                key={category.id}
                onClick={() => inboxCategories.onSelect(category.id)}
                aria-pressed={inboxCategories.active === category.id}
                aria-label={`${category.label}, ${inboxCategories.counts[category.id].toLocaleString()} messages`}
              >
                <Icon size={15} />
                <span>{category.label}</span>
                <small>{inboxCategories.counts[category.id].toLocaleString()}</small>
              </button>
            );
          })}
        </nav>
      )}

      <div className="message-list" role="listbox" aria-label={title}>
        {items.map(({ message, hit }) => (
          <MessageRow
            key={message.id}
            message={message}
            hit={hit}
            readOnly={readOnly}
            selected={selectedMessageId === message.id}
            checked={selectedIds.has(message.id)}
            dragging={draggingMessageId === message.id}
            actionBusy={actionBusy}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
            onArchive={onArchive}
            onSpam={onSpam}
            onToggleRead={onToggleRead}
            onDragStart={(target) => {
              setDraggingMessageId(target.id);
              onDragStart(target);
            }}
            onDragEnd={() => {
              setDraggingMessageId(null);
              onDragEnd();
            }}
          />
        ))}

        {!loading && items.length === 0 && (
          <div className="list-empty">
            {searching ? <SearchX size={28} /> : <Inbox size={28} />}
            <strong>{searching
              ? "No matching messages"
              : inboxCategories
                ? `No ${inboxCategories.active} messages`
                : "No messages here"}</strong>
            <span>{searching
              ? "Adjust the search or filters."
              : inboxCategories
                ? "Choose another Inbox category."
                : "Choose another folder or import an archive."}</span>
          </div>
        )}

        {loading && (
          <div className="list-loading"><LoaderCircle className="spin" size={20} /> Loading messages</div>
        )}

        {hasMore && !loading && (
          <button className="load-more" onClick={onLoadMore}>
            <ChevronDown size={16} /> Load more
          </button>
        )}
      </div>
    </section>
  );
}

function MessageRow({
  message,
  hit,
  readOnly,
  selected,
  checked,
  dragging,
  actionBusy,
  onSelect,
  onToggleSelect,
  onArchive,
  onSpam,
  onToggleRead,
  onDragStart,
  onDragEnd
}: {
  message: MessageSummary;
  hit?: SearchHit;
  readOnly: boolean;
  selected: boolean;
  checked: boolean;
  dragging: boolean;
  actionBusy: boolean;
  onSelect(message: MessageSummary): void;
  onToggleSelect(messageId: string): void;
  onArchive(message: MessageSummary): void;
  onSpam(message: MessageSummary): void;
  onToggleRead(message: MessageSummary): void;
  onDragStart(message: MessageSummary): void;
  onDragEnd(): void;
}) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; offset: number } | null>(null);
  const longPressRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const clearLongPress = () => {
    if (longPressRef.current !== null) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  useEffect(() => () => clearLongPress(), []);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (readOnly || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, offset: swipeOffset };
    setSwiping(true);
    longPressRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      setSwipeOffset(0);
      onToggleSelect(message.id);
    }, 550);
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    if (!start || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) clearLongPress();
    if (Math.abs(deltaY) > Math.abs(deltaX)) return;
    setSwipeOffset(Math.max(-76, Math.min(120, start.offset + deltaX)));
  };

  const handleTouchEnd = () => {
    clearLongPress();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    setSwiping(false);
    if (!start) return;
    const moved = Math.abs(swipeOffset - start.offset);
    if (moved > 10) suppressClickRef.current = true;
    setSwipeOffset(swipeOffset > 48 ? 120 : swipeOffset < -42 ? -76 : 0);
  };

  const runSwipeAction = (action: (target: MessageSummary) => void) => {
    setSwipeOffset(0);
    action(message);
  };

  return (
    <div className={`message-swipe-shell ${swipeOffset === 0 ? "" : "revealed"}`}>
      {!readOnly && (
        <>
          <div className="message-swipe-actions start" aria-hidden={swipeOffset <= 0}>
            <button tabIndex={swipeOffset > 0 ? 0 : -1} disabled={actionBusy} onClick={() => runSwipeAction(onArchive)} aria-label={`Archive ${message.subject}`}>
              <Archive size={19} /><span>Archive</span>
            </button>
            <button tabIndex={swipeOffset > 0 ? 0 : -1} disabled={actionBusy} onClick={() => runSwipeAction(onToggleRead)} aria-label={`${message.state.isRead ? "Mark unread" : "Mark read"}: ${message.subject}`}>
              {message.state.isRead ? <Mail size={19} /> : <MailOpen size={19} />}<span>{message.state.isRead ? "Unread" : "Read"}</span>
            </button>
          </div>
          <div className="message-swipe-actions end" aria-hidden={swipeOffset >= 0}>
            <button tabIndex={swipeOffset < 0 ? 0 : -1} disabled={actionBusy} onClick={() => runSwipeAction(onSpam)} aria-label={`Mark sender as spam: ${message.subject}`}>
              <ShieldAlert size={19} /><span>Spam</span>
            </button>
          </div>
        </>
      )}
      <div
        className={`message-row ${readOnly ? "" : "selectable"} ${selected ? "selected" : ""} ${message.state.isRead ? "read" : "unread"} ${message.hasCalendarEvent ? "calendar-linked" : message.hasPendingFollowUp ? "follow-up-linked" : message.hasAiAnalysis ? "analyzed" : ""} ${dragging ? "dragging" : ""} ${checked ? "checked" : ""} ${swiping ? "swiping" : ""}`}
        role="option"
        tabIndex={0}
        aria-selected={selected}
        draggable={!readOnly}
        style={{ transform: `translateX(${swipeOffset}px)` }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (swipeOffset !== 0) {
            setSwipeOffset(0);
            return;
          }
          onSelect(message);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(message);
          }
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onDragStart={(event) => {
          if (readOnly) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", message.id);
          onDragStart(message);
        }}
        onDragEnd={onDragEnd}
      >
        {!readOnly && (
          <input
            type="checkbox"
            className="message-row-checkbox"
            checked={checked}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleSelect(message.id)}
            aria-label={`Select ${message.subject || "message"}`}
          />
        )}
        <span className="avatar" aria-hidden="true">{initials(message.sender)}</span>
        <span className="message-row-content">
          <span className="message-row-top">
            <strong>{displayAddress(message.sender)}</strong>
            <span className="message-row-time">
              <time>{formatDate(message.receivedAt ?? message.sentAt)}</time>
              <time className="message-row-clock">{formatTimeOfDay(message.receivedAt ?? message.sentAt)}</time>
            </span>
          </span>
          <span className="message-subject-line">
            <span>{message.subject}</span>
            {message.state.isStarred && <Star className="starred" size={14} fill="currentColor" />}
          </span>
          {hit ? (
            <span
              className="message-preview search-snippet"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(hit.snippet, { ALLOWED_TAGS: ["mark"] }) }}
            />
          ) : <span className="message-preview">{message.preview}</span>}
          <span className="message-row-footer">
            <span className="folder-chip">{message.folderPath.split("/").at(-1)}</span>
            {message.hasCalendarEvent ? (
              <span className="message-status-chip calendar"><CalendarClock size={11} />Event</span>
            ) : message.hasPendingFollowUp ? (
              <span className="message-status-chip follow-up"><BellRing size={11} />Follow up</span>
            ) : message.hasAiAnalysis ? (
              <span className="message-status-chip analyzed"><BrainCircuit size={11} />Analyzed</span>
            ) : null}
            {message.hasReply && <span className="message-status-chip replied"><Reply size={11} />Replied</span>}
            {hit?.matchedIn === "attachment" && (
              <span className="attachment-hit"><Paperclip size={12} />{hit.matchedAttachmentName}</span>
            )}
            {message.attachmentCount > 0 && !hit && (
              <span className="attachment-count"><Paperclip size={12} />{message.attachmentCount}</span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}
