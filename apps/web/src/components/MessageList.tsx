import DOMPurify from "dompurify";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import {
  Archive,
  ArrowLeft,
  BellRing,
  BriefcaseBusiness,
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
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  X
} from "lucide-react";
import type {
  InboxCategory,
  InboxCategoryCounts,
  InboxTabDefinition,
  MessageSummary,
  SearchHit
} from "@email-client/shared";
import { displayAddress, formatDate, formatTimeOfDay, initials } from "../lib/format.js";
import { ShipmentHighlights } from "./ShipmentHighlights.js";

export interface MessageListItem {
  message: MessageSummary;
  hit?: SearchHit;
}

export type InboxView = InboxCategory | "focus";

interface MessageListProps {
  items: MessageListItem[];
  selectedMessageId: string | null;
  title: string;
  loading: boolean;
  searching: boolean;
  hasMore: boolean;
  rangeLabel?: string;
  loadMoreLabel?: string;
  readOnly: boolean;
  onSelect(message: MessageSummary): void;
  onDragStart(message: MessageSummary, messageIds: string[]): void;
  onDragEnd(): void;
  onLoadMore(): void;
  onMobileBack(): void;
  inboxCategories?: {
    active: InboxView;
    counts: InboxCategoryCounts;
    tabs: InboxTabDefinition[];
    onSelect(category: InboxView): void;
  } | null;
  selectedIds: Set<string>;
  onToggleSelect(messageId: string): void;
  onToggleSelectAll(): void;
  onSelectFirst(count: number): void;
  onSelectLoaded(): void;
  onSelectEntireView(): void;
  onClearSelection(): void;
  selectionBusy: boolean;
  bulkBusy: boolean;
  onBulkDelete(): void;
  onBulkArchive(): void;
  onBulkSpam(): void;
  onBulkMarkRead(): void;
  onBulkAiFile(): void;
  aiFilingBusy: boolean;
  actionBusy: boolean;
  onArchive(message: MessageSummary): void;
  onSpam(message: MessageSummary): void;
  onToggleRead(message: MessageSummary): void;
}

const CATEGORY_ICONS: Record<InboxCategory, typeof Inbox> = {
  primary: Inbox,
  jobs: BriefcaseBusiness,
  promotions: Tag,
  social: CircleUserRound,
  updates: Info,
  bills: ReceiptText,
  medical: HeartPulse,
  mail_tracking: PackageSearch
};

export function MessageList({
  items,
  selectedMessageId,
  title,
  loading,
  searching,
  hasMore,
  rangeLabel,
  loadMoreLabel = "Load more",
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
  onSelectFirst,
  onSelectLoaded,
  onSelectEntireView,
  onClearSelection,
  selectionBusy,
  bulkBusy,
  onBulkDelete,
  onBulkArchive,
  onBulkSpam,
  onBulkMarkRead,
  onBulkAiFile,
  aiFilingBusy,
  actionBusy,
  onArchive,
  onSpam,
  onToggleRead
}: MessageListProps) {
  const [draggingMessageIds, setDraggingMessageIds] = useState<Set<string>>(new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const rowCallbacksRef = useRef({
    onSelect,
    onToggleSelect,
    onArchive,
    onSpam,
    onToggleRead,
    onDragStart,
    onDragEnd
  });
  rowCallbacksRef.current = {
    onSelect,
    onToggleSelect,
    onArchive,
    onSpam,
    onToggleRead,
    onDragStart,
    onDragEnd
  };
  const selectedCount = selectedIds.size;
  const focusMode = inboxCategories?.active === "focus";
  const activeCategoryLabel = inboxCategories && !focusMode
    ? inboxCategories.tabs.find((tab) => tab.id === inboxCategories.active)?.label ?? inboxCategories.active
    : null;
  const displayItems = useMemo(
    () => focusMode ? [...items].sort(compareFocusItems) : items,
    [focusMode, items]
  );
  const focusSections = useMemo(
    () => focusMode ? groupFocusItems(displayItems) : [],
    [displayItems, focusMode]
  );
  const unreadCount = displayItems.filter((item) => !item.message.state.isRead).length;
  const allVisibleSelected = displayItems.length > 0 && displayItems.every((item) => selectedIds.has(item.message.id));
  const selectRow = useCallback((target: MessageSummary) => rowCallbacksRef.current.onSelect(target), []);
  const toggleRow = useCallback((messageId: string) => rowCallbacksRef.current.onToggleSelect(messageId), []);
  const archiveRow = useCallback((target: MessageSummary) => rowCallbacksRef.current.onArchive(target), []);
  const spamRow = useCallback((target: MessageSummary) => rowCallbacksRef.current.onSpam(target), []);
  const toggleReadRow = useCallback((target: MessageSummary) => rowCallbacksRef.current.onToggleRead(target), []);
  const startRowDrag = useCallback((target: MessageSummary, messageIds: string[]) => {
    setDraggingMessageIds(new Set(messageIds));
    rowCallbacksRef.current.onDragStart(target, messageIds);
  }, []);
  const endRowDrag = useCallback(() => {
    setDraggingMessageIds(new Set());
    rowCallbacksRef.current.onDragEnd();
  }, []);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allVisibleSelected;
    }
  }, [allVisibleSelected, selectedCount]);

  const renderRow = ({ message, hit }: MessageListItem) => (
    <MessageRow
      key={message.id}
      message={message}
      hit={hit}
      readOnly={readOnly}
      selected={selectedMessageId === message.id}
      checked={selectedIds.has(message.id)}
      dragging={draggingMessageIds.has(message.id)}
      dragMessageIds={selectedIds.has(message.id) ? [...selectedIds] : [message.id]}
      actionBusy={actionBusy}
      onSelect={selectRow}
      onToggleSelect={toggleRow}
      onArchive={archiveRow}
      onSpam={spamRow}
      onToggleRead={toggleReadRow}
      onDragStart={startRowDrag}
      onDragEnd={endRowDrag}
    />
  );

  const selectionMenu = (
    <SelectionMenu
      loadedCount={displayItems.length}
      hasMore={hasMore}
      selectedCount={selectedCount}
      busy={selectionBusy}
      onSelectFirst={onSelectFirst}
      onSelectLoaded={onSelectLoaded}
      onSelectEntireView={onSelectEntireView}
      onClearSelection={onClearSelection}
    />
  );

  return (
    <section className="message-list-pane" aria-label="Messages">
      <header className="pane-header message-list-header">
        {selectedCount > 0 ? (
          <div className="message-bulk-toolbar">
            <button className="icon-button" onClick={onClearSelection} title="Clear selection" aria-label="Clear selection" disabled={bulkBusy}>
              <X size={17} />
            </button>
            {selectionMenu}
            <span>{selectedCount.toLocaleString()} selected</span>
            <div className="message-bulk-actions">
              <button className="icon-button ai-bulk-file" onClick={onBulkAiFile} disabled={bulkBusy} title="Ask AI where to file selected messages" aria-label="AI file selected messages">
                {aiFilingBusy ? <LoaderCircle className="spin" size={17} /> : <BrainCircuit size={17} />}
              </button>
              <button className="icon-button bulk-read-button" onClick={onBulkMarkRead} disabled={bulkBusy} title="Mark selected messages as read" aria-label="Mark selected as read">
                <MailOpen size={17} /><span>Read</span>
              </button>
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
              <div className="message-selection-controls">
                <label
                  className="message-select-hit"
                  title={allVisibleSelected ? "Deselect all loaded messages" : "Select all loaded messages"}
                >
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="message-select-all"
                    checked={allVisibleSelected}
                    onChange={onToggleSelectAll}
                    aria-label={allVisibleSelected ? "Deselect all loaded messages" : "Select all loaded messages"}
                  />
                </label>
                {selectionMenu}
              </div>
            )}
            <div className="message-heading-copy">
              {focusMode && <small className="message-heading-eyebrow">Your daily catch-up</small>}
              <h2>{title}</h2>
              <span>
                {focusMode
                  ? `${unreadCount.toLocaleString()} unread · ${displayItems.length.toLocaleString()} to review`
                  : `${displayItems.length.toLocaleString()}${hasMore ? "+" : ""} shown`}
                {rangeLabel && <small className="message-range-label"> · {rangeLabel}</small>}
              </span>
            </div>
            {focusMode && (
              <div className="focus-safety-note" title="Known junk and low-value bulk mail stay out of Focus">
                <ShieldCheck size={15} /><span>Low-priority mail set aside</span>
              </div>
            )}
          </>
        )}
      </header>

      {selectedCount > 0 && allVisibleSelected && (
        <div className="message-selection-scope" role="status" aria-live="polite">
          {hasMore && selectedCount === items.length ? (
            <>
              <span>All {items.length.toLocaleString()} loaded messages are selected.</span>
              <button
                type="button"
                onClick={onSelectEntireView}
                disabled={selectionBusy || bulkBusy}
              >
                {selectionBusy && <LoaderCircle className="spin" size={14} />}
                Select all available in {title} (up to 500)
              </button>
            </>
          ) : (
            <span>
              {hasMore
                ? `${selectedCount.toLocaleString()} messages selected for bulk action.`
                : `All ${selectedCount.toLocaleString()} messages in ${title} are selected.`}
            </span>
          )}
        </div>
      )}

      {inboxCategories && (
        <nav
          className="inbox-category-tabs"
          aria-label="Inbox categories"
          style={{ "--inbox-tab-count": inboxCategories.tabs.filter((tab) => tab.enabled).length + 1 } as CSSProperties}
        >
          <button
            className={`inbox-category-tab focus ${inboxCategories.active === "focus" ? "active" : ""}`}
            onClick={() => inboxCategories.onSelect("focus")}
            aria-pressed={inboxCategories.active === "focus"}
            aria-label="Focus, important mail from today and yesterday"
            title="People, replies, follow-ups, career, and useful account mail from today and yesterday"
            style={{ "--inbox-tab-color": "#176747" } as CSSProperties}
          >
            <ShieldCheck size={15} />
            <span>Focus</span>
            <small>{focusMode ? displayItems.length.toLocaleString() : "Now"}</small>
          </button>
          {inboxCategories.tabs.filter((category) => category.enabled).sort((left, right) => left.position - right.position).map((category) => {
            const Icon = CATEGORY_ICONS[category.id];
            const count = inboxCategories.counts[category.id] ?? 0;
            return (
              <button
                className={`inbox-category-tab ${category.id} ${inboxCategories.active === category.id ? "active" : ""}`}
                key={category.id}
                onClick={() => inboxCategories.onSelect(category.id)}
                aria-pressed={inboxCategories.active === category.id}
                aria-label={`${category.label}, ${count.toLocaleString()} messages`}
                title={category.description}
                style={{ "--inbox-tab-color": category.color } as CSSProperties}
              >
                <Icon size={15} />
                <span>{category.label}</span>
                <small>{count.toLocaleString()}</small>
              </button>
            );
          })}
        </nav>
      )}

      <div className={`message-list ${focusMode ? "focus-list" : ""}`} role="list" aria-label={title}>
        {inboxCategories?.active === "mail_tracking" && (
          <ShipmentHighlights messages={items.map((item) => item.message)} onSelect={selectRow} />
        )}
        {focusMode ? focusSections.map((section) => (
          <section className="focus-date-section" aria-labelledby={`focus-date-${section.key}`} key={section.key}>
            <header className="focus-date-heading" id={`focus-date-${section.key}`}>
              <span>{section.label}</span>
              <small>{section.items.length.toLocaleString()} {section.items.length === 1 ? "message" : "messages"}</small>
            </header>
            {section.items.map(renderRow)}
          </section>
        )) : displayItems.map(renderRow)}

        {!loading && items.length === 0 && (
          <div className="list-empty">
            {searching ? <SearchX size={28} /> : <Inbox size={28} />}
            <strong>{searching
              ? "No matching messages"
              : focusMode
                ? "You’re caught up"
              : activeCategoryLabel
                ? `No ${activeCategoryLabel} messages`
                : "No messages here"}</strong>
            <span>{searching
              ? "Adjust the search or filters."
              : focusMode
                ? "Nothing important from today or yesterday needs your attention."
              : activeCategoryLabel
                ? "Choose another Inbox category."
                : "Choose another folder or import an archive."}</span>
          </div>
        )}

        {loading && (
          items.length === 0 ? (
            <div className="message-list-skeleton" role="status" aria-label="Loading messages">
              {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
            </div>
          ) : (
            <div className="list-loading"><LoaderCircle className="spin" size={20} /> Loading messages</div>
          )
        )}

        {hasMore && !loading && (
          <button className="load-more" onClick={onLoadMore}>
            <ChevronDown size={16} /> {loadMoreLabel}
          </button>
        )}
      </div>
    </section>
  );
}

interface FocusSection {
  key: string;
  label: string;
  items: MessageListItem[];
}

function compareFocusItems(left: MessageListItem, right: MessageListItem): number {
  const leftDate = localDateKey(left.message.receivedAt ?? left.message.sentAt);
  const rightDate = localDateKey(right.message.receivedAt ?? right.message.sentAt);
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  const priority = focusPriority(left.message) - focusPriority(right.message);
  if (priority !== 0) return priority;
  if (left.message.state.isRead !== right.message.state.isRead) {
    return left.message.state.isRead ? 1 : -1;
  }
  return messageTime(right.message) - messageTime(left.message);
}

function groupFocusItems(items: MessageListItem[]): FocusSection[] {
  const groups = new Map<string, MessageListItem[]>();
  for (const item of items) {
    const key = localDateKey(item.message.receivedAt ?? item.message.sentAt);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, sectionItems]) => ({ key, label: focusDateLabel(key), items: sectionItems }));
}

function focusPriority(message: MessageSummary): number {
  if (message.hasPendingFollowUp) return 0;
  if (message.hasReply || /^\s*(?:re|fwd?):/i.test(message.subject)) return 1;
  if (message.inboxCategory === "primary") return 2;
  if (message.inboxCategory === "jobs") return 3;
  if (message.inboxCategory === "medical" || message.inboxCategory === "bills") return 4;
  if (message.inboxCategory === "updates") return 5;
  if (message.inboxCategory === "mail_tracking") return 6;
  return 7;
}

function messageTime(message: MessageSummary): number {
  const value = message.receivedAt ?? message.sentAt;
  return value ? new Date(value).getTime() || 0 : 0;
}

function localDateKey(value: string | null): string {
  if (!value) return "0000-00-00";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "0000-00-00";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function focusDateLabel(key: string): string {
  if (key === "0000-00-00") return "Date unavailable";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const keyFor = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (key === keyFor(today)) return "Today";
  if (key === keyFor(yesterday)) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" })
    .format(new Date(year, month - 1, day));
}

function SelectionMenu({
  loadedCount,
  hasMore,
  selectedCount,
  busy,
  onSelectFirst,
  onSelectLoaded,
  onSelectEntireView,
  onClearSelection
}: {
  loadedCount: number;
  hasMore: boolean;
  selectedCount: number;
  busy: boolean;
  onSelectFirst(count: number): void;
  onSelectLoaded(): void;
  onSelectEntireView(): void;
  onClearSelection(): void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="message-selection-anchor" ref={anchorRef}>
      <button
        className="message-selection-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={busy || loadedCount === 0}
        aria-label="Choose messages to select"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Selection options"
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <ChevronDown size={17} />}
      </button>
      {open && (
        <div className="message-selection-popover" role="menu" aria-label="Message selection options">
          <button type="button" role="menuitem" onClick={() => run(() => onSelectFirst(20))}>
            <strong>Select first 20</strong>
            <small>{Math.min(20, loadedCount).toLocaleString()} available</small>
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => onSelectFirst(50))}>
            <strong>Select first 50</strong>
            <small>{Math.min(50, loadedCount).toLocaleString()} available</small>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onSelectLoaded)}>
            <strong>Select all loaded</strong>
            <small>{loadedCount.toLocaleString()} messages</small>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onSelectEntireView)}>
            <strong>Select entire view</strong>
            <small>{hasMore ? "Up to 500 matches" : `${loadedCount.toLocaleString()} messages`}</small>
          </button>
          {selectedCount > 0 && (
            <button type="button" role="menuitem" className="clear" onClick={() => run(onClearSelection)}>
              <strong>Clear selection</strong>
              <small>{selectedCount.toLocaleString()} selected</small>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface MessageRowProps {
  message: MessageSummary;
  hit?: SearchHit;
  readOnly: boolean;
  selected: boolean;
  checked: boolean;
  dragging: boolean;
  dragMessageIds: string[];
  actionBusy: boolean;
  onSelect(message: MessageSummary): void;
  onToggleSelect(messageId: string): void;
  onArchive(message: MessageSummary): void;
  onSpam(message: MessageSummary): void;
  onToggleRead(message: MessageSummary): void;
  onDragStart(message: MessageSummary, messageIds: string[]): void;
  onDragEnd(): void;
}

const MessageRow = memo(function MessageRow({
  message,
  hit,
  readOnly,
  selected,
  checked,
  dragging,
  dragMessageIds,
  actionBusy,
  onSelect,
  onToggleSelect,
  onArchive,
  onSpam,
  onToggleRead,
  onDragStart,
  onDragEnd
}: MessageRowProps) {
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
        className={`message-row ${readOnly ? "" : "selectable"} ${selected ? "selected" : ""} ${message.state.isRead ? "read" : "unread"} ${message.hasPendingFollowUp ? "follow-up-linked" : message.hasCalendarEvent ? "calendar-linked" : message.hasAiAnalysis ? "analyzed" : ""} ${dragging ? "dragging" : ""} ${checked ? "checked" : ""} ${swiping ? "swiping" : ""}`}
        role="listitem"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        title={dragMessageIds.length > 1 ? `Drag to move ${dragMessageIds.length.toLocaleString()} selected messages` : undefined}
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
          event.dataTransfer.setData("text/plain", dragMessageIds.join("\n"));
          event.dataTransfer.setData("application/x-archive-mail-messages", JSON.stringify(dragMessageIds));
          onDragStart(message, dragMessageIds);
        }}
        onDragEnd={onDragEnd}
      >
        {!readOnly && (
          <label className="message-row-select-hit" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              className="message-row-checkbox"
              checked={checked}
              onChange={() => onToggleSelect(message.id)}
              aria-label={`Select ${message.subject || "message"}`}
            />
          </label>
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
            {message.hasPendingFollowUp && <span className="message-status-chip follow-up"><BellRing size={11} />Follow up</span>}
            {(message.hasReply || /^\s*(?:re|fwd?):/i.test(message.subject)) && <span className="message-status-chip replied"><Reply size={11} />Conversation</span>}
            {message.inboxCategory === "jobs" && <span className="message-status-chip career"><BriefcaseBusiness size={11} />Career</span>}
            {message.inboxCategory === "primary" && !message.hasPendingFollowUp && !message.hasReply && !/^\s*(?:re|fwd?):/i.test(message.subject) && <span className="message-status-chip person"><CircleUserRound size={11} />Person</span>}
            {message.hasCalendarEvent && <span className="message-status-chip calendar"><CalendarClock size={11} />Event</span>}
            {message.hasAiAnalysis && <span className="message-status-chip analyzed"><BrainCircuit size={11} />AI brief</span>}
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
}, (previous, next) => (
  previous.message === next.message
  && previous.hit === next.hit
  && previous.readOnly === next.readOnly
  && previous.selected === next.selected
  && previous.checked === next.checked
  && previous.dragging === next.dragging
  && previous.actionBusy === next.actionBusy
  && previous.dragMessageIds.length === next.dragMessageIds.length
  && previous.dragMessageIds.every((id, index) => id === next.dragMessageIds[index])
));
