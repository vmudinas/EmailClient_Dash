import DOMPurify from "dompurify";
import { useState } from "react";
import {
  ArrowLeft,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  Inbox,
  LoaderCircle,
  Paperclip,
  SearchX,
  Star
} from "lucide-react";
import type {
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
}

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
  onMobileBack
}: MessageListProps) {
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(null);
  return (
    <section className="message-list-pane" aria-label="Messages">
      <header className="pane-header message-list-header">
        <button className="icon-button mobile-only" onClick={onMobileBack} title="Back to folders" aria-label="Back to folders">
          <ArrowLeft size={18} />
        </button>
        <div>
          <h2>{title}</h2>
          <span>{items.length.toLocaleString()}{hasMore ? "+" : ""} shown</span>
        </div>
      </header>

      <div className="message-list" role="listbox" aria-label={title}>
        {items.map(({ message, hit }) => (
          <button
            className={`message-row ${selectedMessageId === message.id ? "selected" : ""} ${message.state.isRead ? "read" : "unread"} ${message.hasCalendarEvent ? "calendar-linked" : message.hasAiAnalysis ? "analyzed" : ""} ${draggingMessageId === message.id ? "dragging" : ""}`}
            key={message.id}
            role="option"
            aria-selected={selectedMessageId === message.id}
            draggable={!readOnly}
            onClick={() => onSelect(message)}
            onDragStart={(event) => {
              if (readOnly) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", message.id);
              setDraggingMessageId(message.id);
              onDragStart(message);
            }}
            onDragEnd={() => {
              setDraggingMessageId(null);
              onDragEnd();
            }}
          >
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
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(hit.snippet, { ALLOWED_TAGS: ["mark"] })
                  }}
                />
              ) : (
                <span className="message-preview">{message.preview}</span>
              )}
              <span className="message-row-footer">
                <span className="folder-chip">{message.folderPath.split("/").at(-1)}</span>
                {message.hasCalendarEvent ? (
                  <span className="message-status-chip calendar"><CalendarClock size={11} />Event</span>
                ) : message.hasAiAnalysis ? (
                  <span className="message-status-chip analyzed"><BrainCircuit size={11} />Analyzed</span>
                ) : null}
                {hit?.matchedIn === "attachment" && (
                  <span className="attachment-hit">
                    <Paperclip size={12} />
                    {hit.matchedAttachmentName}
                  </span>
                )}
                {message.attachmentCount > 0 && !hit && (
                  <span className="attachment-count"><Paperclip size={12} />{message.attachmentCount}</span>
                )}
              </span>
            </span>
          </button>
        ))}

        {!loading && items.length === 0 && (
          <div className="list-empty">
            {searching ? <SearchX size={28} /> : <Inbox size={28} />}
            <strong>{searching ? "No matching messages" : "No messages here"}</strong>
            <span>{searching ? "Adjust the search or filters." : "Choose another folder or import an archive."}</span>
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
