import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Archive,
  Activity,
  BookOpen,
  CalendarDays,
  FileEdit,
  Filter,
  FolderOpen,
  Import,
  List,
  LoaderCircle,
  LogOut,
  Mail,
  MailPlus,
  MonitorSmartphone,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  X
} from "lucide-react";
import type {
  Archive as ArchiveModel,
  AuthSessionInfo,
  DiagnosticsSnapshot,
  EmailDraft,
  Folder,
  GmailAuthRequest,
  GmailConnection,
  GmailSendRequest,
  ImportJob,
  LocalMessageStatePatch,
  MessageDetail,
  MessageSummary,
  RuntimeConfig,
  SearchFilters,
  SearchHit,
  SharingState
} from "@email-client/shared";
import { Sidebar } from "./components/Sidebar.js";
import {
  MessageList,
  type MessageListItem
} from "./components/MessageList.js";
import { MessageReader } from "./components/MessageReader.js";
import { CalendarView } from "./components/CalendarView.js";
import {
  EMPTY_FILTERS,
  CombineArchiveDialog,
  CombineMailboxDialog,
  CreateMailboxDialog,
  DiagnosticsDialog,
  FilterPanel,
  ImportDialog,
  GmailDialog,
  RenameDialog,
  ShareDialog,
  type UiSearchFilters
} from "./components/Dialogs.js";
import { ApiClient, resolveRuntimeConfig, type UploadProgress } from "./lib/api.js";
import { ComposeDialog, type ComposeDraft } from "./components/ComposeDialog.js";
import { DraftsDialog } from "./components/DraftsDialog.js";
import { GuideDialog } from "./components/GuideDialog.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { displayAddress, formatDateTime } from "./lib/format.js";

type MobileView = "folders" | "messages" | "reader";
type SmartMailbox = "starred";
type RenameTarget =
  | { kind: "archive"; id: string; name: string }
  | { kind: "mailbox"; id: string; archiveId: string; name: string };

const EMPTY_SHARING: SharingState = {
  enabled: false,
  url: null,
  expiresAt: null
};

const SESSION_STORAGE_KEY = "archive-mail-session-token";

export function App() {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [api, setApi] = useState<ApiClient | null>(null);
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [archives, setArchives] = useState<ArchiveModel[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<MessageListItem[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedSmartMailbox, setSelectedSmartMailbox] = useState<SmartMailbox | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState<UiSearchFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<"relevance" | "newest">("relevance");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [startupError, setStartupError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileView, setMobileView] = useState<MobileView>("folders");
  const [viewMode, setViewMode] = useState<"mail" | "calendar">("mail");
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<UploadProgress | null>(null);
  const [importError, setImportError] = useState("");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [createMailboxOpen, setCreateMailboxOpen] = useState(false);
  const [createMailboxBusy, setCreateMailboxBusy] = useState(false);
  const [combineSource, setCombineSource] = useState<ArchiveModel | null>(null);
  const [combineBusy, setCombineBusy] = useState(false);
  const [combineMailboxSource, setCombineMailboxSource] = useState<Folder | null>(null);
  const [combineMailboxBusy, setCombineMailboxBusy] = useState(false);
  const [gmailOpen, setGmailOpen] = useState(false);
  const [gmailConnections, setGmailConnections] = useState<GmailConnection[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailError, setGmailError] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeConnectionId, setComposeConnectionId] = useState<string | null>(null);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState("");
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsBusy, setDraftsBusy] = useState(false);
  const [draftsError, setDraftsError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [spamBusy, setSpamBusy] = useState(false);
  const [draggedMessage, setDraggedMessage] = useState<MessageSummary | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsClearing, setDiagnosticsClearing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [pendingDiagnosticCount, setPendingDiagnosticCount] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [sharing, setSharing] = useState<SharingState>(EMPTY_SHARING);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const gmailStatusRef = useRef(new Map<string, GmailConnection["status"]>());

  const readOnly = !session || session.role === "viewer";
  const isAdmin = session?.role === "admin";
  const electron = Boolean(window.emailClient);
  const selectedArchive = archives.find((archive) => archive.id === selectedArchiveId) ?? null;
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const activeFilterCount = Object.values(filters).filter((value) => value !== "" && value !== undefined).length;

  const showError = useCallback((value: string) => {
    setNotice(value);
    window.setTimeout(() => setNotice((current) => current === value ? "" : current), 5_000);
  }, []);

  const updateMessageIndicators = useCallback((
    messageId: string,
    patch: { hasAiAnalysis?: boolean; hasCalendarEvent?: boolean }
  ) => {
    setItems((current) => current.map((item) => item.message.id === messageId
      ? { ...item, message: { ...item.message, ...patch } }
      : item));
    setMessage((current) => current?.id === messageId ? { ...current, ...patch } : current);
  }, []);

  const loadAuthenticatedData = useCallback(async (client: ApiClient) => {
    const loadedArchives = await client.listArchives();
    void client.flushClientDiagnostics().then(() => {
      setPendingDiagnosticCount(client.pendingDiagnosticCount());
    });
    setArchives(loadedArchives);
    setSelectedArchiveId((current) => (
      current && loadedArchives.some((archive) => archive.id === current)
        ? current
        : loadedArchives[0]?.id ?? null
    ));
  }, []);

  const connect = useCallback(async () => {
    setInitializing(true);
    setStartupError("");
    try {
      const config = await resolveRuntimeConfig();
      const client = new ApiClient(config);
      client.setAuthorizationRequiredHandler(() => {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        client.setAccessToken("");
        setSession(null);
        setSettingsOpen(false);
        setNotice("Your session expired. Sign in again.");
      });
      setRuntime(config);
      setApi(client);
      const savedToken = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (savedToken) {
        client.setAccessToken(savedToken);
        try {
          const activeSession = await client.currentSession();
          setSession(activeSession);
          await loadAuthenticatedData(client);
        } catch {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          client.setAccessToken("");
          setSession(null);
        }
      } else {
        setSession(null);
      }
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : "Archive Mail could not connect");
    } finally {
      setInitializing(false);
    }
  }, [loadAuthenticatedData]);

  const login = async (username: string, pin: string) => {
    if (!api) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const result = await api.login(username, pin);
      sessionStorage.setItem(SESSION_STORAGE_KEY, result.accessToken);
      setSession(result.session);
      await loadAuthenticatedData(api);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const signOutLocally = () => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    api?.setAccessToken("");
    setSession(null);
    setSettingsOpen(false);
    setArchives([]);
    setFolders([]);
    setItems([]);
    setJobs([]);
    setMessage(null);
    setSelectedArchiveId(null);
    setSelectedFolderId(null);
    setSelectedMessageId(null);
  };

  const logout = async () => {
    try {
      await api?.logout();
    } catch {
      // A missing or expired server session is already effectively signed out.
    } finally {
      signOutLocally();
    }
  };

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchTerm(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setFilterOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  const refreshArchives = useCallback(async () => {
    if (!api) return;
    const loaded = await api.listArchives();
    setArchives(loaded);
    setSelectedArchiveId((current) => (
      current && loaded.some((archive) => archive.id === current)
        ? current
        : loaded[0]?.id ?? null
    ));
  }, [api]);

  const refreshJobs = useCallback(async () => {
    if (!api || readOnly) return;
    try {
      const loaded = await api.listImportJobs();
      setJobs(loaded);
      if (loaded.some((job) => job.status === "running" || job.status === "queued")) {
        await refreshArchives();
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import status could not be loaded");
    }
  }, [api, readOnly, refreshArchives, showError]);

  const refreshDiagnostics = useCallback(async () => {
    if (!api || readOnly) return;
    setDiagnosticsLoading(true);
    try {
      await api.flushClientDiagnostics();
      const loaded = await api.diagnostics();
      setDiagnostics(loaded);
      setPendingDiagnosticCount(api.pendingDiagnosticCount());
    } catch (error) {
      setPendingDiagnosticCount(api.pendingDiagnosticCount());
      showError(error instanceof Error ? error.message : "Diagnostics could not be loaded");
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [api, readOnly, showError]);

  const openDiagnostics = useCallback(() => {
    setDiagnosticsOpen(true);
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  useEffect(() => {
    if (!api || readOnly) return;
    void refreshJobs();
    const interval = window.setInterval(() => void refreshJobs(), 1_500);
    return () => window.clearInterval(interval);
  }, [api, readOnly, refreshJobs]);

  useEffect(() => {
    if (!api || !selectedArchiveId) {
      setFolders([]);
      return;
    }
    let active = true;
    void api.listFolders(selectedArchiveId)
      .then((loaded) => {
        if (active) setFolders(loaded);
      })
      .catch((error) => showError(error instanceof Error ? error.message : "Folders could not be loaded"));
    return () => { active = false; };
  }, [api, selectedArchiveId, showError]);

  const loadMessages = useCallback(async (append = false) => {
    if (!api || !selectedArchiveId) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    setLoadingMessages(true);
    try {
      if (searchTerm) {
        const searchFilters: SearchFilters = {
          archiveId: selectedArchiveId,
          folderId: selectedFolderId ?? undefined,
          starred: selectedSmartMailbox === "starred" ? true : undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          after: filters.after || undefined,
          before: filters.before || undefined,
          hasAttachment: filters.hasAttachment,
          sort,
          cursor: append ? nextCursor ?? undefined : undefined,
          limit: 50
        };
        const page = await api.search(searchTerm, searchFilters);
        setItems((current) => append
          ? [...current, ...page.items.map(hitToItem)]
          : page.items.map(hitToItem));
        setNextCursor(page.nextCursor);
      } else {
        const page = await api.listMessages({
          archiveId: selectedArchiveId,
          folderId: selectedFolderId ?? undefined,
          starred: selectedSmartMailbox === "starred" ? true : undefined,
          cursor: append ? nextCursor ?? undefined : undefined,
          limit: 50
        });
        setItems((current) => append
          ? [...current, ...page.items.map(messageToItem)]
          : page.items.map(messageToItem));
        setNextCursor(page.nextCursor);
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Messages could not be loaded");
    } finally {
      setLoadingMessages(false);
    }
  }, [
    api,
    selectedArchiveId,
    selectedFolderId,
    selectedSmartMailbox,
    searchTerm,
    filters,
    sort,
    nextCursor,
    showError
  ]);

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setSelectedMessageId(null);
    setMessage(null);
    void loadMessages(false);
  }, [api, selectedArchiveId, selectedFolderId, selectedSmartMailbox, searchTerm, filters, sort]);

  const loadFoldersForGmail = useCallback(async (archiveId: string): Promise<Folder[]> => {
    if (!api) return [];
    return api.listFolders(archiveId);
  }, [api]);

  const loadSendAsAliases = useCallback(async (connectionId: string) => {
    if (!api) return [];
    try {
      return await api.listGmailSendAsAliases(connectionId);
    } catch {
      return [];
    }
  }, [api]);

  const refreshGmailConnections = useCallback(async (showLoading = false) => {
    if (!api || readOnly) return;
    if (showLoading) setGmailLoading(true);
    try {
      const loaded = await api.listGmailConnections();
      const previous = gmailStatusRef.current;
      const idsChanged = loaded.length !== previous.size
        || loaded.some((connection) => !previous.has(connection.id));
      const syncFinished = loaded.some((connection) => (
        previous.get(connection.id) === "syncing" && connection.status !== "syncing"
      ));
      gmailStatusRef.current = new Map(loaded.map((connection) => [connection.id, connection.status]));
      setGmailConnections(loaded);
      if (idsChanged || syncFinished || loaded.some((connection) => connection.status === "syncing")) {
        await refreshArchives();
      }
      if (syncFinished) {
        if (selectedArchiveId) setFolders(await api.listFolders(selectedArchiveId));
        await loadMessages(false);
      }
    } catch (error) {
      setGmailError(error instanceof Error ? error.message : "Gmail status could not be loaded");
    } finally {
      if (showLoading) setGmailLoading(false);
    }
  }, [api, readOnly, refreshArchives, selectedArchiveId, loadMessages]);

  useEffect(() => {
    if (!api || readOnly) return;
    void refreshGmailConnections(false);
  }, [api, readOnly, refreshGmailConnections]);

  useEffect(() => {
    const syncing = gmailConnections.some((connection) => connection.status === "syncing");
    if (!gmailOpen && !syncing) return;
    void refreshGmailConnections(gmailOpen);
    const interval = window.setInterval(() => void refreshGmailConnections(false), 1_500);
    return () => window.clearInterval(interval);
  }, [gmailOpen, gmailConnections.some((connection) => connection.status === "syncing"), refreshGmailConnections]);

  const refreshMailboxCounts = useCallback(async () => {
    if (!api) return;
    await refreshArchives();
    if (selectedArchiveId) setFolders(await api.listFolders(selectedArchiveId));
  }, [api, refreshArchives, selectedArchiveId]);

  useEffect(() => {
    if (!selectedMessageId && runtime?.platform !== "mobile" && items[0]) {
      void openMessage(items[0].message, false);
    }
  }, [items, runtime?.platform]);

  const openMessage = async (summary: MessageSummary, moveMobile = true) => {
    if (!api) return;
    setSelectedMessageId(summary.id);
    if (moveMobile) setMobileView("reader");
    setLoadingMessage(true);
    try {
      const detail = await api.getMessage(summary.id);
      setMessage(detail);
      if (!readOnly && !detail.state.isRead) {
        const state = await api.updateMessageState(detail.id, { isRead: true });
        mergeMessageState(detail.id, state);
        void refreshMailboxCounts();
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be opened");
    } finally {
      setLoadingMessage(false);
    }
  };

  const mergeMessageState = (
    messageId: string,
    state: MessageDetail["state"]
  ) => {
    setMessage((current) => current?.id === messageId ? { ...current, state } : current);
    setItems((current) => current.map((item) => (
      item.message.id === messageId
        ? {
            ...item,
            message: { ...item.message, state },
            hit: item.hit ? { ...item.hit, message: { ...item.hit.message, state } } : undefined
          }
        : item
    )));
  };

  const updateState = async (patch: LocalMessageStatePatch) => {
    if (!api || !message || readOnly) return;
    try {
      const state = await api.updateMessageState(message.id, patch);
      mergeMessageState(message.id, state);
      if (patch.isRead !== undefined || patch.isStarred !== undefined) await refreshMailboxCounts();
      if (patch.isStarred === false && selectedSmartMailbox === "starred") {
        setSelectedMessageId(null);
        setMessage(null);
        await loadMessages(false);
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be updated");
      throw error;
    }
  };

  const selectArchive = (id: string) => {
    setSelectedArchiveId(id);
    setSelectedFolderId(null);
    setSelectedSmartMailbox(null);
    setMobileView("messages");
  };

  const selectFolder = (id: string | null) => {
    setSelectedFolderId(id);
    setSelectedSmartMailbox(null);
    setMobileView("messages");
  };

  const selectSmartMailbox = (mailbox: SmartMailbox) => {
    setSelectedFolderId(null);
    setSelectedSmartMailbox(mailbox);
    setMobileView("messages");
  };

  const openImport = () => {
    setImportProgress(null);
    setImportError("");
    setImportOpen(true);
  };

  const startImport = async (file: File | null, ocrEnabled: boolean) => {
    if (!api || readOnly) return;
    setImportBusy(true);
    setImportError("");
    setImportProgress(null);
    const controller = !window.emailClient && file ? new AbortController() : null;
    importAbortRef.current = controller;
    try {
      const job = window.emailClient
        ? await window.emailClient.selectAndImport({ ocrEnabled }, api?.getAccessToken() ?? "")
        : file
          ? await api.uploadArchive(file, ocrEnabled, setImportProgress, controller?.signal)
          : null;
      if (job) {
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        setImportOpen(false);
        setImportProgress(null);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setImportOpen(false);
        setImportProgress(null);
        showError("Upload cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : "Import could not be started";
      setImportError(message);
      showError(message);
      if (window.emailClient) {
        void api.reportClientIssue(error, { operation: "desktop_import" });
      }
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null;
      setImportBusy(false);
    }
  };

  const cancelUpload = async () => {
    if (!api || !importProgress?.uploadId) return;
    const uploadId = importProgress.uploadId;
    importAbortRef.current?.abort();
    try {
      await api.cancelUpload(uploadId);
      setImportOpen(false);
      setImportProgress(null);
      setImportError("");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Upload could not be cancelled");
    }
  };

  const cancelJob = async (jobId: string) => {
    if (!api) return;
    try {
      const job = window.emailClient
        ? await window.emailClient.cancelImport(jobId, api?.getAccessToken() ?? "")
        : await api.cancelImport(jobId);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import could not be cancelled");
    }
  };

  const resumeJob = async (jobId: string) => {
    if (!api) return;
    try {
      const job = window.emailClient
        ? await window.emailClient.resumeImport(jobId, api?.getAccessToken() ?? "")
        : await api.resumeImport(jobId);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import could not be resumed");
    }
  };

  const clearJob = async (jobId: string) => {
    if (!api || readOnly) return;
    const job = jobs.find((item) => item.id === jobId);
    if (!job) return;
    const removesPartialArchive = job.status === "paused" || job.status === "cancelled" || job.status === "failed";
    const confirmed = window.confirm(removesPartialArchive
      ? `Clear the stopped import "${job.sourceName}"? Its partial archive, indexed messages, attachments, checkpoint, and managed upload copy will be permanently removed.`
      : `Clear the import record for "${job.sourceName}"? The completed archive and its mail will be kept.`);
    if (!confirmed) return;

    try {
      await api.clearImport(jobId);
      setJobs((current) => current.filter((item) => item.id !== jobId));
      if (removesPartialArchive && job.archiveId === selectedArchiveId) {
        setSelectedFolderId(null);
        setSelectedMessageId(null);
        setMessage(null);
      }
      await refreshArchives();
      if (diagnosticsOpen) await refreshDiagnostics();
      showError(removesPartialArchive ? "Stopped import and partial data cleared" : "Import record cleared");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import could not be cleared");
    }
  };

  const removeArchive = async (archiveId: string) => {
    const archive = archives.find((item) => item.id === archiveId);
    if (!archive || !window.confirm(
      archive.sourceType === "gmail"
        ? `Remove "${archive.name}" and all of its managed local data? Gmail sync will be disconnected. The Gmail account itself will not be changed.`
        : `Remove "${archive.name}" and all of its managed local data? Any active import will be stopped. The original PST/MBOX will not be changed.`
    )) return;
    try {
      if (window.emailClient) await window.emailClient.removeArchive(archiveId, api?.getAccessToken() ?? "");
      else if (api) await api.removeArchive(archiveId);
      setJobs((current) => current.filter((job) => job.archiveId !== archiveId));
      await refreshArchives();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Archive could not be removed");
    }
  };

  const removeFolder = async (folder: Folder) => {
    if (!api || readOnly) return;
    const affectedFolders = folders.filter((candidate) => (
      candidate.path === folder.path || candidate.path.startsWith(`${folder.path}/`)
    ));
    const messageCount = affectedFolders.reduce((total, candidate) => total + candidate.messageCount, 0);
    if (!window.confirm(
      `Delete mailbox "${folder.name}", its child mailboxes, and ${messageCount.toLocaleString()} local message${messageCount === 1 ? "" : "s"}? Connected Gmail syncs will be disconnected. Original PST/MBOX/Gmail sources will not be changed.`
    )) return;
    try {
      await api.removeFolder(folder.id);
      const selectedFolderWasDeleted = affectedFolders.some((candidate) => candidate.id === selectedFolderId);
      if (selectedFolderWasDeleted) {
        setSelectedFolderId(null);
      }
      setSelectedMessageId(null);
      setMessage(null);
      setFolders(await api.listFolders(folder.archiveId));
      await refreshArchives();
      if (!selectedFolderWasDeleted) await loadMessages(false);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Mailbox could not be deleted");
    }
  };

  const renameSelected = async (name: string) => {
    if (!api || !renameTarget || readOnly) return;
    setRenameBusy(true);
    try {
      if (renameTarget.kind === "archive") {
        const renamed = await api.renameArchive(renameTarget.id, name);
        setArchives((current) => current.map((archive) => archive.id === renamed.id ? renamed : archive));
      } else {
        await api.renameFolder(renameTarget.id, name);
        const loadedFolders = await api.listFolders(renameTarget.archiveId);
        setFolders(loadedFolders);
        await loadMessages(false);
      }
      setRenameTarget(null);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Name could not be changed");
    } finally {
      setRenameBusy(false);
    }
  };

  const createMailbox = async (name: string, parentId: string | null) => {
    if (!api || !selectedArchiveId || readOnly) return;
    setCreateMailboxBusy(true);
    try {
      const folder = await api.createFolder(selectedArchiveId, name, parentId);
      setFolders(await api.listFolders(selectedArchiveId));
      setSelectedFolderId(folder.id);
      setCreateMailboxOpen(false);
      await refreshArchives();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Mailbox could not be created");
    } finally {
      setCreateMailboxBusy(false);
    }
  };

  const combineArchives = async (targetArchiveId: string) => {
    if (!api || !combineSource || readOnly) return;
    setCombineBusy(true);
    try {
      const result = await api.combineArchives(combineSource.id, targetArchiveId);
      setCombineSource(null);
      setSelectedArchiveId(result.archive.id);
      setSelectedFolderId(null);
      setSelectedMessageId(null);
      setMessage(null);
      await refreshArchives();
      setFolders(await api.listFolders(result.archive.id));
      await refreshJobs();
      showError(
        `${result.movedMessages.toLocaleString()} messages and ${result.movedAttachments.toLocaleString()} attachments combined into ${result.archive.name}`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Archives could not be combined");
    } finally {
      setCombineBusy(false);
    }
  };

  const combineMailboxes = async (targetFolderId: string) => {
    if (!api || !combineMailboxSource || readOnly) return;
    setCombineMailboxBusy(true);
    try {
      const result = await api.combineMailboxes(combineMailboxSource.id, targetFolderId);
      setCombineMailboxSource(null);
      setSelectedArchiveId(result.mailbox.archiveId);
      setSelectedFolderId(result.mailbox.id);
      setSelectedMessageId(null);
      setMessage(null);
      setFolders(await api.listFolders(result.mailbox.archiveId));
      await refreshArchives();
      showError(
        `${result.movedMessages.toLocaleString()} messages and ${result.movedAttachments.toLocaleString()} attachments combined into ${result.mailbox.path}`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Mailboxes could not be combined");
    } finally {
      setCombineMailboxBusy(false);
    }
  };

  const openGmail = () => {
    setGmailError("");
    setGmailOpen(true);
  };

  const openCompose = (connection: GmailConnection | null = null, draft: ComposeDraft | null = null) => {
    setComposeConnectionId(connection?.id ?? gmailConnections.find((item) => item.canSend)?.id ?? null);
    setComposeDraft(draft);
    setComposeError("");
    setComposeOpen(true);
  };

  const loadDrafts = async () => {
    if (!api || readOnly) return;
    setDraftsLoading(true);
    setDraftsError("");
    try {
      setDrafts(await api.listDrafts());
    } catch (error) {
      setDraftsError(error instanceof Error ? error.message : "Drafts could not be loaded");
    } finally {
      setDraftsLoading(false);
    }
  };

  const openDrafts = () => {
    setDraftsOpen(true);
    void loadDrafts();
  };

  const editSavedDraft = (draft: EmailDraft) => {
    setDraftsOpen(false);
    openCompose(gmailConnections.find((connection) => connection.id === draft.connectionId) ?? null, {
      id: draft.id,
      source: draft.source,
      sourceMessageId: draft.sourceMessageId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyText: draft.bodyText,
      fromAddress: draft.fromAddress,
      resumeId: draft.resumeId,
      resumeFilename: draft.resumeFilename
    });
  };

  const deleteSavedDraft = async (draft: EmailDraft) => {
    if (!api || !window.confirm(`Delete the draft "${draft.subject || "(No subject)"}"?`)) return;
    setDraftsBusy(true);
    setDraftsError("");
    try {
      await api.deleteDraft(draft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
    } catch (error) {
      setDraftsError(error instanceof Error ? error.message : "Draft could not be deleted");
    } finally {
      setDraftsBusy(false);
    }
  };

  const sendSavedDraft = async (draft: EmailDraft) => {
    if (!api || readOnly) return;
    const fromAddress = draft.fromAddress || draft.connectionEmail;
    if (!window.confirm(
      `Send "${draft.subject || "(No subject)"}" to ${draft.to.join(", ") || "(no recipient)"} from ${fromAddress}?`
    )) return;
    setDraftsBusy(true);
    setDraftsError("");
    try {
      const result = await api.sendDraft(draft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
      await refreshMailboxCounts();
      const connection = gmailConnections.find((entry) => entry.id === draft.connectionId);
      if (connection?.archiveId === selectedArchiveId) await loadMessages(false);
      showError(result.localCopyImported
        ? `Draft sent from ${fromAddress}`
        : "Draft sent, but the local sent copy could not be imported. Open Diagnostics for details.");
    } catch (error) {
      const value = error instanceof Error ? error.message : "Draft could not be sent";
      setDraftsError(value);
      showError(value);
    } finally {
      setDraftsBusy(false);
    }
  };

  const openReply = (target: MessageDetail, mode: "reply" | "forward") => {
    const quotedLines = target.bodyText.split("\n").map((line) => `> ${line}`).join("\n");
    const quoted = `\n\nOn ${formatDateTime(target.receivedAt ?? target.sentAt)}, ${displayAddress(target.sender)} <${target.sender.address}> wrote:\n${quotedLines}`;
    const prefix = mode === "reply" ? "Re: " : "Fwd: ";
    const subject = target.subject.toLowerCase().startsWith(prefix.trim().toLowerCase())
      ? target.subject
      : `${prefix}${target.subject}`;
    openCompose(null, {
      to: mode === "reply" ? target.sender.address : "",
      subject,
      bodyText: quoted
    });
  };

  const moveMessage = async (messageId: string, folderId: string) => {
    if (!api || readOnly) return;
    setMoveBusy(true);
    try {
      const moved = await api.moveMessage(messageId, folderId);
      if (message?.id === messageId) setMessage(moved);
      await Promise.all([refreshArchives(), loadMessages(false)]);
      showError(`Moved to ${moved.folderPath}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be moved");
    } finally {
      setMoveBusy(false);
    }
  };

  const archiveMessage = async (target: MessageDetail) => {
    if (!api || readOnly) return;
    setMoveBusy(true);
    try {
      let availableFolders = target.archiveId === selectedArchiveId
        ? folders
        : await api.listFolders(target.archiveId);
      let currentFolder = availableFolders.find((folder) => folder.id === target.folderId) ?? null;
      if (!currentFolder) {
        availableFolders = await api.listFolders(target.archiveId);
        currentFolder = availableFolders.find((folder) => folder.id === target.folderId) ?? null;
      }
      const archiveNames = new Set(["archive", "archived"]);
      let destination = availableFolders.find((folder) => (
        folder.parentId === currentFolder?.parentId
        && archiveNames.has(folder.name.trim().toLowerCase())
      )) ?? availableFolders.find((folder) => archiveNames.has(folder.name.trim().toLowerCase()));
      if (!destination) {
        destination = await api.createFolder(target.archiveId, "Archived", currentFolder?.parentId ?? null);
        if (target.archiveId === selectedArchiveId) {
          setFolders(await api.listFolders(target.archiveId));
        }
      }
      const moved = await api.moveMessage(target.id, destination.id);
      if (message?.id === target.id) setMessage(moved);
      await Promise.all([refreshArchives(), loadMessages(false)]);
      showError(`Moved to ${moved.folderPath}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be archived");
    } finally {
      setMoveBusy(false);
    }
  };

  const spamSender = async (target: MessageDetail) => {
    if (!api || readOnly) return;
    const senderAddress = target.sender.address.trim();
    if (!senderAddress) {
      showError("This message does not have a sender address");
      return;
    }
    if (!window.confirm(
      `Move all messages from ${senderAddress} to Spam locally and automatically file future imported Inbox messages from this sender there?`
    )) return;

    setSpamBusy(true);
    try {
      const result = await api.markSenderAsSpam(target.id);
      if (message?.id === target.id) setMessage(result.message);
      await Promise.all([
        refreshArchives(),
        loadMessages(false),
        target.archiveId === selectedArchiveId
          ? api.listFolders(target.archiveId).then(setFolders)
          : Promise.resolve()
      ]);
      showError(
        `${senderAddress} will now go to ${result.spamFolderPath}. Moved ${result.movedMessages.toLocaleString()} existing message${result.movedMessages === 1 ? "" : "s"}.`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Sender could not be marked as spam");
    } finally {
      setSpamBusy(false);
    }
  };

  const dropMessageIntoFolder = (messageId: string, folderId: string) => {
    setDraggedMessage(null);
    void moveMessage(messageId, folderId);
  };

  const connectGmail = async (request: GmailAuthRequest) => {
    if (!api || readOnly) return;
    setGmailBusy(true);
    setGmailError("");
    const popup = !window.emailClient ? window.open("", "_blank") : null;
    if (popup) popup.opener = null;
    try {
      const authorization = await api.startGmailAuthorization(request);
      if (popup) popup.location.href = authorization.authorizationUrl;
      else window.open(authorization.authorizationUrl, "_blank", "noopener,noreferrer");
      showError("Finish Gmail authorization in your browser");
    } catch (error) {
      popup?.close();
      const message = error instanceof Error ? error.message : "Gmail authorization could not start";
      setGmailError(message);
      showError(message);
    } finally {
      setGmailBusy(false);
    }
  };

  const reauthorizeGmail = (connection: GmailConnection) => {
    void connectGmail({
      archiveId: connection.archiveId,
      folderId: connection.folderId,
      archiveName: connection.archiveName,
      folderName: connection.folderPath.split("/").at(-1) || "Gmail",
      query: connection.query,
      ocrEnabled: connection.ocrEnabled
    });
  };

  const syncGmail = async (connectionId: string, options: { full?: boolean } = {}) => {
    if (!api || readOnly) return;
    setGmailError("");
    try {
      const connection = await api.syncGmail(connectionId, options);
      setGmailConnections((current) => current.map((item) => item.id === connection.id ? connection : item));
    } catch (error) {
      setGmailError(error instanceof Error ? error.message : "Gmail sync could not start");
    }
  };

  const cancelGmail = async (connectionId: string) => {
    if (!api || readOnly) return;
    try {
      const connection = await api.cancelGmailSync(connectionId);
      setGmailConnections((current) => current.map((item) => item.id === connection.id ? connection : item));
    } catch (error) {
      setGmailError(error instanceof Error ? error.message : "Gmail sync could not be stopped");
    }
  };

  const reorganizeGmail = async (connectionId: string) => {
    if (!api || readOnly) return;
    setGmailError("");
    try {
      const connection = await api.reorganizeGmailFolders(connectionId);
      setGmailConnections((current) => current.map((item) => item.id === connection.id ? connection : item));
    } catch (error) {
      setGmailError(error instanceof Error ? error.message : "Gmail folder reorganize could not start");
    }
  };

  const disconnectGmail = async (connection: GmailConnection) => {
    if (!api || readOnly || !window.confirm(
      `Disconnect ${connection.email}? Already imported messages and attachments will remain in local storage.`
    )) return;
    try {
      await api.removeGmailConnection(connection.id);
      setGmailConnections((current) => current.filter((item) => item.id !== connection.id));
      gmailStatusRef.current.delete(connection.id);
    } catch (error) {
      setGmailError(error instanceof Error ? error.message : "Gmail could not be disconnected");
    }
  };

  const sendGmailMessage = async (connectionId: string, message: GmailSendRequest) => {
    if (!api || readOnly) return;
    setComposeBusy(true);
    setComposeError("");
    const connection = gmailConnections.find((item) => item.id === connectionId) ?? null;
    try {
      let result;
      if (composeDraft?.id) {
        await api.updateDraft(composeDraft.id, {
          connectionId,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          bodyText: message.bodyText,
          fromAddress: message.fromAddress ?? null,
          resumeId: composeDraft.resumeId ?? null
        });
        result = await api.sendDraft(composeDraft.id);
        setDrafts((current) => current.filter((entry) => entry.id !== composeDraft.id));
      } else {
        result = await api.sendGmailMessage(connectionId, message);
      }
      setComposeOpen(false);
      await refreshMailboxCounts();
      if (connection?.archiveId === selectedArchiveId) await loadMessages(false);
      showError(result.localCopyImported
        ? `Email sent from ${connection?.email ?? "Gmail"}`
        : "Email sent, but the local sent copy could not be imported. Open Diagnostics for details.");
    } catch (error) {
      const value = error instanceof Error ? error.message : "Email could not be sent";
      setComposeError(value);
      showError(value);
    } finally {
      setComposeBusy(false);
    }
  };

  const saveComposeDraft = async (connectionId: string, message: GmailSendRequest) => {
    if (!api || readOnly) return;
    setComposeBusy(true);
    setComposeError("");
    try {
      const input = {
        connectionId,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        bodyText: message.bodyText,
        fromAddress: message.fromAddress ?? null,
        resumeId: composeDraft?.resumeId ?? null
      };
      const saved = composeDraft?.id
        ? await api.updateDraft(composeDraft.id, input)
        : await api.createDraft({
            ...input,
            sourceMessageId: composeDraft?.sourceMessageId ?? null
          });
      setDrafts((current) => current.some((entry) => entry.id === saved.id)
        ? current.map((entry) => entry.id === saved.id ? saved : entry)
        : [saved, ...current]);
      setComposeOpen(false);
      showError("Draft saved");
    } catch (error) {
      const value = error instanceof Error ? error.message : "Draft could not be saved";
      setComposeError(value);
      showError(value);
    } finally {
      setComposeBusy(false);
    }
  };

  const downloadDiagnostics = async () => {
    if (!api) return;
    try {
      await api.downloadDiagnostics();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Diagnostics could not be exported");
    }
  };

  const clearDiagnostics = async () => {
    if (!api || readOnly) return;
    if (!window.confirm("Clear all stored diagnostic events? This cannot be undone.")) return;
    setDiagnosticsClearing(true);
    try {
      await api.flushClientDiagnostics();
      await api.clearDiagnostics();
      setDiagnostics(await api.diagnostics());
      setPendingDiagnosticCount(api.pendingDiagnosticCount());
    } catch (error) {
      showError(error instanceof Error ? error.message : "Diagnostics could not be cleared");
    } finally {
      setDiagnosticsClearing(false);
    }
  };

  const openSharing = async () => {
    setShareOpen(true);
    if (!window.emailClient) return;
    try {
      const state = api ? await api.getSharingState() : EMPTY_SHARING;
      setSharing(state);
    } catch {
      setSharing(EMPTY_SHARING);
    }
  };

  const toggleSharing = async (enabled: boolean) => {
    if (!window.emailClient) return;
    setShareBusy(true);
    try {
      setSharing(await window.emailClient.setSharingEnabled(enabled, api?.getAccessToken() ?? ""));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Sharing could not be changed");
    } finally {
      setShareBusy(false);
    }
  };

  const listTitle = searchTerm
    ? `Search: ${searchTerm}`
    : selectedSmartMailbox === "starred"
      ? "Starred"
      : selectedFolder?.name ?? (selectedArchive ? "All mail" : "Messages");

  if (initializing) {
    return (
      <main className="startup-screen">
        <span className="brand-mark"><Archive size={24} /></span>
        <strong>Archive Mail</strong>
        <LoaderCircle className="spin" size={20} />
      </main>
    );
  }

  if (startupError) {
    return (
      <main className="startup-screen error-screen">
        <span className="brand-mark"><Mail size={24} /></span>
        <strong>Archive Mail is unavailable</strong>
        <p>{startupError}</p>
        <button className="primary-button" onClick={() => void connect()}>
          <RefreshCw size={17} /> Retry
        </button>
      </main>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        busy={loginBusy}
        error={loginError}
        pairedViewer={Boolean(runtime?.pairingToken)}
        onLogin={(username, pin) => void login(username, pin)}
      />
    );
  }

  return (
    <div className={`app-shell mobile-view-${mobileView}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Archive size={20} /></span>
          <span>Archive Mail</span>
        </div>

        <div className="search-wrap">
          <Search className="search-icon" size={18} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mail and attachments"
            aria-label="Search mail and attachments"
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")} title="Clear search" aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="topbar-actions">
          {searchTerm && (
            <div className="sort-segment" aria-label="Search sort">
              <button className={sort === "relevance" ? "selected" : ""} onClick={() => setSort("relevance")}>Best</button>
              <button className={sort === "newest" ? "selected" : ""} onClick={() => setSort("newest")}>Newest</button>
            </div>
          )}
          <div className="filter-anchor">
            <button
              className={`icon-button ${activeFilterCount > 0 ? "active" : ""}`}
              onClick={() => setFilterOpen((open) => !open)}
              title="Search filters"
              aria-label="Search filters"
            >
              <SlidersHorizontal size={18} />
              {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <FilterPanel
              open={filterOpen}
              value={filters}
              onChange={setFilters}
              onClose={() => setFilterOpen(false)}
            />
          </div>
          <button
            className={`icon-button calendar-trigger ${viewMode === "calendar" ? "active" : ""}`}
            onClick={() => setViewMode((current) => (current === "calendar" ? "mail" : "calendar"))}
            title={viewMode === "calendar" ? "Back to mail" : "Open calendar"}
            aria-label={viewMode === "calendar" ? "Back to mail" : "Open calendar"}
          >
            {viewMode === "calendar" ? <Mail size={18} /> : <CalendarDays size={18} />}
          </button>
          {electron && isAdmin && (
            <button className="icon-button sharing-trigger" onClick={() => void openSharing()} title="Open iPhone viewer" aria-label="Open iPhone viewer">
              <MonitorSmartphone size={18} />
            </button>
          )}
          {!readOnly && (
            <button className="icon-button drafts-trigger" onClick={openDrafts} title="Open drafts" aria-label="Open drafts">
              <FileEdit size={18} />
            </button>
          )}
          {!readOnly && (
            <button className="icon-button compose-trigger" onClick={() => openCompose()} title="Compose email" aria-label="Compose email">
              <MailPlus size={18} />
            </button>
          )}
          <button className="icon-button guide-trigger" onClick={() => setGuideOpen(true)} title="Open guide" aria-label="Open guide">
            <BookOpen size={18} />
          </button>
          {isAdmin && (
            <button className="icon-button settings-trigger" onClick={() => setSettingsOpen(true)} title="Open admin settings" aria-label="Open admin settings">
              <SettingsIcon size={18} />
            </button>
          )}
          {!readOnly && (
            <button className="icon-button diagnostics-trigger" onClick={openDiagnostics} title="Open diagnostics" aria-label="Open diagnostics">
              <Activity size={18} />
              {pendingDiagnosticCount > 0 && <span className="diagnostic-count">{Math.min(99, pendingDiagnosticCount)}</span>}
            </button>
          )}
          {!readOnly && (
            <button className="primary-button top-import" onClick={openImport}>
              <Import size={17} /> <span>Import</span>
            </button>
          )}
          <span className="signed-in-user" title={`${session.user.displayName} · ${session.role}`}>{session.user.username}</span>
          <button className="icon-button logout-trigger" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
            <LogOut size={18} />
          </button>
          {readOnly && <span className="read-only-badge">Read only</span>}
        </div>
      </header>

      <main className="workspace">
        {viewMode === "calendar" ? (
          api && <CalendarView api={api} connections={gmailConnections} onReauthorize={reauthorizeGmail} onError={showError} />
        ) : (
          <>
            <Sidebar
              archives={archives}
              folders={folders}
              jobs={jobs}
              selectedArchiveId={selectedArchiveId}
              selectedFolderId={selectedFolderId}
              selectedSmartMailbox={selectedSmartMailbox}
              readOnly={readOnly}
              draggedMessage={draggedMessage}
              moveBusy={moveBusy}
              onSelectArchive={selectArchive}
              onSelectFolder={selectFolder}
              onSelectSmartMailbox={selectSmartMailbox}
              onImport={openImport}
              onOpenGmail={openGmail}
              onCreateFolder={() => setCreateMailboxOpen(true)}
              onCombineArchive={setCombineSource}
              onCombineFolder={setCombineMailboxSource}
              onCancelJob={(id) => void cancelJob(id)}
              onResumeJob={(id) => void resumeJob(id)}
              onClearJob={(id) => void clearJob(id)}
              onRemoveArchive={(id) => void removeArchive(id)}
              onRemoveFolder={(folder) => void removeFolder(folder)}
              onRenameArchive={(archive) => setRenameTarget({ kind: "archive", id: archive.id, name: archive.name })}
              onRenameFolder={(folder) => setRenameTarget({ kind: "mailbox", id: folder.id, archiveId: folder.archiveId, name: folder.name })}
              onMoveMessage={dropMessageIntoFolder}
              onOpenDiagnostics={openDiagnostics}
            />
            <MessageList
              items={items}
              selectedMessageId={selectedMessageId}
              title={listTitle}
              loading={loadingMessages}
              searching={Boolean(searchTerm)}
              hasMore={Boolean(nextCursor)}
              readOnly={readOnly}
              onSelect={(selected) => void openMessage(selected)}
              onDragStart={setDraggedMessage}
              onDragEnd={() => setDraggedMessage(null)}
              onLoadMore={() => void loadMessages(true)}
              onMobileBack={() => setMobileView("folders")}
            />
            <MessageReader
              key={message?.id ?? "empty-reader"}
              message={message}
              loading={loadingMessage}
              readOnly={readOnly}
              api={api}
              connections={gmailConnections}
              onMobileBack={() => setMobileView("messages")}
              onUpdateState={updateState}
              onError={showError}
              onReply={(target) => openReply(target, "reply")}
              onForward={(target) => openReply(target, "forward")}
              onLoadFolders={loadFoldersForGmail}
              onMove={(messageId, folderId) => moveMessage(messageId, folderId)}
              onArchive={archiveMessage}
              onSpamSender={spamSender}
              onIndicatorsChange={updateMessageIndicators}
              moveBusy={moveBusy}
              spamBusy={spamBusy}
            />
          </>
        )}
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={mobileView === "folders" ? "selected" : ""} onClick={() => setMobileView("folders")}>
          <FolderOpen size={19} /><span>Folders</span>
        </button>
        <button className={mobileView === "messages" ? "selected" : ""} onClick={() => setMobileView("messages")}>
          <List size={19} /><span>Messages</span>
        </button>
        <button className={mobileView === "reader" ? "selected" : ""} onClick={() => setMobileView("reader")} disabled={!message}>
          <Mail size={19} /><span>Reader</span>
        </button>
      </nav>

      <ImportDialog
        open={importOpen}
        electron={electron}
        busy={importBusy}
        progress={importProgress}
        error={importError}
        onClose={() => {
          setImportOpen(false);
          setImportProgress(null);
          setImportError("");
        }}
        onOpenDiagnostics={() => {
          setImportOpen(false);
          openDiagnostics();
        }}
        onCancelUpload={() => void cancelUpload()}
        onImport={(file, ocr) => void startImport(file, ocr)}
      />
      <RenameDialog
        target={renameTarget}
        busy={renameBusy}
        onClose={() => setRenameTarget(null)}
        onRename={(name) => void renameSelected(name)}
      />
      <CreateMailboxDialog
        open={createMailboxOpen}
        archive={selectedArchive}
        folders={folders}
        busy={createMailboxBusy}
        onClose={() => setCreateMailboxOpen(false)}
        onCreate={(name, parentId) => void createMailbox(name, parentId)}
      />
      <CombineArchiveDialog
        source={combineSource}
        archives={archives}
        busy={combineBusy}
        onClose={() => setCombineSource(null)}
        onCombine={(targetArchiveId) => void combineArchives(targetArchiveId)}
      />
      <CombineMailboxDialog
        source={combineMailboxSource}
        folders={folders}
        busy={combineMailboxBusy}
        onClose={() => setCombineMailboxSource(null)}
        onCombine={(targetFolderId) => void combineMailboxes(targetFolderId)}
      />
      <GmailDialog
        open={gmailOpen}
        archives={archives}
        selectedArchiveId={selectedArchiveId}
        connections={gmailConnections}
        loading={gmailLoading}
        busy={gmailBusy}
        error={gmailError}
        onClose={() => setGmailOpen(false)}
        onLoadFolders={loadFoldersForGmail}
        onConnect={(request) => void connectGmail(request)}
        onSync={(connectionId) => void syncGmail(connectionId)}
        onFullSync={(connectionId) => void syncGmail(connectionId, { full: true })}
        onCancel={(connectionId) => void cancelGmail(connectionId)}
        onReorganize={(connectionId) => void reorganizeGmail(connectionId)}
        onCompose={(connection) => {
          setGmailOpen(false);
          openCompose(connection);
        }}
        onReauthorize={reauthorizeGmail}
        onDisconnect={(connection) => void disconnectGmail(connection)}
      />
      <ComposeDialog
        open={composeOpen}
        connections={gmailConnections}
        initialConnectionId={composeConnectionId}
        initialDraft={composeDraft}
        busy={composeBusy}
        error={composeError}
        onClose={() => { if (!composeBusy) setComposeOpen(false); }}
        onOpenGmail={() => {
          setComposeOpen(false);
          openGmail();
        }}
        onLoadSendAsAliases={loadSendAsAliases}
        onSave={(connectionId, outgoing) => void saveComposeDraft(connectionId, outgoing)}
        onSend={(connectionId, outgoing) => void sendGmailMessage(connectionId, outgoing)}
      />
      <DraftsDialog
        open={draftsOpen}
        drafts={drafts}
        loading={draftsLoading}
        busy={draftsBusy}
        error={draftsError}
        onClose={() => { if (!draftsBusy) setDraftsOpen(false); }}
        onRefresh={() => void loadDrafts()}
        onEdit={editSavedDraft}
        onSend={(draft) => void sendSavedDraft(draft)}
        onDelete={(draft) => void deleteSavedDraft(draft)}
      />
      <GuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />
      {isAdmin && (
        <SettingsDialog
          open={settingsOpen}
          api={api}
          session={session}
          onClose={() => setSettingsOpen(false)}
          onSignedOut={signOutLocally}
        />
      )}
      <DiagnosticsDialog
        open={diagnosticsOpen}
        data={diagnostics}
        loading={diagnosticsLoading}
        clearing={diagnosticsClearing}
        pendingCount={pendingDiagnosticCount}
        onClose={() => setDiagnosticsOpen(false)}
        onRefresh={() => void refreshDiagnostics()}
        onDownload={() => void downloadDiagnostics()}
        onClear={() => void clearDiagnostics()}
      />
      <ShareDialog
        open={shareOpen}
        state={sharing}
        busy={shareBusy}
        onClose={() => setShareOpen(false)}
        onToggle={(enabled) => void toggleSharing(enabled)}
      />

      {notice && (
        <div className="toast" role="status">
          <Filter size={16} />
          <span>{notice}</span>
          <button className="icon-button subtle" onClick={() => setNotice("")} title="Dismiss" aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}
    </div>
  );
}

function hitToItem(hit: SearchHit): MessageListItem {
  return { message: hit.message, hit };
}

function messageToItem(message: MessageSummary): MessageListItem {
  return { message };
}
