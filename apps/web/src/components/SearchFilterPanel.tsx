import { useEffect, useState } from "react";
import { Filter, X } from "lucide-react";
import type { Folder } from "@email-client/shared";

export interface UiSearchFilters {
  folderId: string;
  from: string;
  to: string;
  after: string;
  before: string;
  hasAttachment: boolean | undefined;
}

export const EMPTY_FILTERS: UiSearchFilters = {
  folderId: "",
  from: "",
  to: "",
  after: "",
  before: "",
  hasAttachment: undefined
};

export const ALL_MAIL_SEARCH_SCOPE = "__all_mail__";

interface FilterPanelProps {
  open: boolean;
  value: UiSearchFilters;
  folders: Folder[];
  currentFolderLabel: string;
  onChange(value: UiSearchFilters): void;
  onClose(): void;
}

export function FilterPanel({
  open,
  value,
  folders,
  currentFolderLabel,
  onChange,
  onClose
}: FilterPanelProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, open]);
  if (!open) return null;
  return (
    <section className="filter-popover" role="dialog" aria-label="Search filters">
      <header>
        <div><Filter size={17} /><strong>Search filters</strong></div>
        <button className="icon-button subtle" onClick={onClose} title="Close filters" aria-label="Close filters"><X size={16} /></button>
      </header>
      <label>
        <span>Search in</span>
        <select
          value={draft.folderId}
          onChange={(event) => setDraft({ ...draft, folderId: event.target.value })}
          aria-label="Search in mailbox"
        >
          <option value="">Current view — {currentFolderLabel}</option>
          <option value={ALL_MAIL_SEARCH_SCOPE}>Entire archive</option>
          <optgroup label="Specific mailbox">
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
          </optgroup>
        </select>
      </label>
      <label><span>From</span><input value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} placeholder="name or address" /></label>
      <label><span>To or CC</span><input value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} placeholder="name or address" /></label>
      <div className="filter-date-grid">
        <label><span>After</span><input type="date" value={draft.after} onChange={(event) => setDraft({ ...draft, after: event.target.value })} /></label>
        <label><span>Before</span><input type="date" value={draft.before} onChange={(event) => setDraft({ ...draft, before: event.target.value })} /></label>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.hasAttachment === true}
          onChange={(event) => setDraft({ ...draft, hasAttachment: event.target.checked ? true : undefined })}
        />
        <span>Has attachments</span>
      </label>
      <footer>
        <button className="text-button" onClick={() => {
          setDraft(EMPTY_FILTERS);
          onChange(EMPTY_FILTERS);
        }}>Clear</button>
        <button className="primary-button compact" onClick={() => {
          onChange(draft);
          onClose();
        }}>Apply</button>
      </footer>
    </section>
  );
}
