import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  Suspense,
  useState
} from "react";
import {
  Archive,
  BrainCircuit,
  Building2,
  CalendarDays,
  FileEdit,
  Filter,
  FolderOpen,
  Eye,
  EyeOff,
  Import,
  List,
  LoaderCircle,
  LogOut,
  Mail,
  MailPlus,
  MonitorSmartphone,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  X
} from "lucide-react";
import type {
  Archive as ArchiveModel,
  AiReviewAnalysisItem,
  AiReviewQueue,
  AuthSessionInfo,
  BulkMoveDestination,
  DiagnosticsSnapshot,
  EmailDraft,
  Folder,
  GmailAuthRequest,
  GmailConnection,
  GmailSendRequest,
  ImportJob,
  InboxCategory,
  InboxCategoryCounts,
  InboxTabSettings,
  LocalMessageStatePatch,
  MessageActionSuggestion,
  MessageDetail,
  MessageFilingSuggestion,
  MessageSummary,
  NewsHeadline,
  RuntimeConfig,
  SearchFilters,
  SearchHit,
  SharingState,
  StockQuote,
  UserScreenId
} from "@email-client/shared";
import { DEFAULT_INBOX_TABS, userCanAccessScreen } from "@email-client/shared";
import { Sidebar } from "./components/Sidebar.js";
import {
  MessageList,
  type MessageListItem
} from "./components/MessageList.js";
import { MessageReader } from "./components/MessageReader.js";
import { CalendarView } from "./components/CalendarView.js";
import {
  ALL_MAIL_SEARCH_SCOPE,
  EMPTY_FILTERS,
  CombineArchiveDialog,
  CombineMailboxDialog,
  CreateMailboxDialog,
  DiagnosticsDialog,
  FilterPanel,
  ImportDialog,
  GmailDialog,
  MailboxDropDialog,
  RenameDialog,
  ShareDialog,
  type UiSearchFilters
} from "./components/Dialogs.js";
import { ApiClient, resolveRuntimeConfig, type UploadProgress } from "./lib/api.js";
import { ComposeDialog, type ComposeDraft } from "./components/ComposeDialog.js";
import { DraftsDialog } from "./components/DraftsDialog.js";
import { GuideDialog } from "./components/GuideDialog.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { TenantInvitationScreen } from "./components/TenantInvitationScreen.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { AiReviewQueueDialog } from "./components/AiReviewQueueDialog.js";
import { MessageActionDialog, type ReviewAction } from "./components/MessageActionDialog.js";
import { StockTickerBar } from "./components/StockTickerBar.js";
import { NewsTickerBar } from "./components/NewsTickerBar.js";
import { displayAddress, formatDateTime } from "./lib/format.js";

const GMAIL_OAUTH_RESULT_KEY = "archive-mail-gmail-oauth-result";

interface GmailOAuthResult {
  type: "archive-mail-gmail-oauth";
  success?: boolean;
  message?: string;
}

type MobileView = "folders" | "messages" | "reader";
type AppView = "mail" | "calendar" | "properties";
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
const SHOW_READ_STORAGE_KEY = "archive-mail-show-read-messages";
const FOLDER_PANEL_STORAGE_KEY = "archive-mail-folder-panel-visible";
const EMPTY_INBOX_CATEGORY_COUNTS: InboxCategoryCounts = {
  primary: 0,
  promotions: 0,
  social: 0,
  updates: 0,
  bills: 0,
  medical: 0,
  mail_tracking: 0
};

function defaultInboxTabSettings(archiveId = ""): InboxTabSettings {
  return {
    archiveId,
    tabs: DEFAULT_INBOX_TABS.map((tab) => ({ ...tab, keywords: [], senderDomains: [] })),
    aiEnabled: false,
    aiConfidenceThreshold: 0.8,
    updatedAt: null
  };
}

const BULK_MOVE_LABELS: Record<BulkMoveDestination, { verb: string; noun: string }> = {
  trash: { verb: "delete", noun: "Trash" },
  archived: { verb: "archive", noun: "Archive" },
  spam: { verb: "mark as spam", noun: "Spam" }
};

const MAX_BULK_SELECTION = 500;
const PropertyManagementView = lazy(async () => {
  const module = await import("./components/PropertyManagementView.js");
  return { default: module.PropertyManagementView };
});

function viewForPath(pathname = window.location.pathname): AppView {
  if (pathname.startsWith("/properties") || pathname.startsWith("/portal")) return "properties";
  if (pathname.startsWith("/calendar")) return "calendar";
  return "mail";
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [api, setApi] = useState<ApiClient | null>(null);
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [stockQuotes, setStockQuotes] = useState<StockQuote[]>([]);
  const [stockQuotesLoading, setStockQuotesLoading] = useState(false);
  const [stockQuotesError, setStockQuotesError] = useState("");
  const [newsHeadlines, setNewsHeadlines] = useState<NewsHeadline[]>([]);
  const [newsHeadlinesLoading, setNewsHeadlinesLoading] = useState(false);
  const [newsHeadlinesError, setNewsHeadlinesError] = useState("");
  const [newsSecondsPerHeadline, setNewsSecondsPerHeadline] = useState(8);
  const [stockSecondsPerSymbol, setStockSecondsPerSymbol] = useState(8);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [archives, setArchives] = useState<ArchiveModel[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<MessageListItem[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedSmartMailbox, setSelectedSmartMailbox] = useState<SmartMailbox | null>(null);
  const [inboxCategory, setInboxCategory] = useState<InboxCategory>("primary");
  const [inboxCategoryCounts, setInboxCategoryCounts] = useState<InboxCategoryCounts>(EMPTY_INBOX_CATEGORY_COUNTS);
  const [inboxTabSettings, setInboxTabSettings] = useState<InboxTabSettings>(() => defaultInboxTabSettings());
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [aiFilingBusy, setAiFilingBusy] = useState(false);
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState<UiSearchFilters>(EMPTY_FILTERS);
  const [showReadMessages, setShowReadMessages] = useState(() => {
    try {
      return window.localStorage.getItem(SHOW_READ_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [folderPanelVisible, setFolderPanelVisible] = useState(() => {
    try {
      return window.localStorage.getItem(FOLDER_PANEL_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [sort, setSort] = useState<"relevance" | "newest">("relevance");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [startupError, setStartupError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileView, setMobileView] = useState<MobileView>("folders");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<AppView>(() => viewForPath());
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<UploadProgress | null>(null);
  const [importError, setImportError] = useState("");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [createMailboxOpen, setCreateMailboxOpen] = useState(false);
  const [createMailboxBusy, setCreateMailboxBusy] = useState(false);
  const [createMailboxParentId, setCreateMailboxParentId] = useState<string | null>(null);
  const [combineSource, setCombineSource] = useState<ArchiveModel | null>(null);
  const [combineBusy, setCombineBusy] = useState(false);
  const [combineMailboxSource, setCombineMailboxSource] = useState<Folder | null>(null);
  const [combineMailboxBusy, setCombineMailboxBusy] = useState(false);
  const [mailboxDrop, setMailboxDrop] = useState<{ source: Folder; target: Folder } | null>(null);
  const [mailboxDropBusy, setMailboxDropBusy] = useState(false);
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
  const [reviewQueueOpen, setReviewQueueOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<AiReviewQueue | null>(null);
  const [reviewQueueLoading, setReviewQueueLoading] = useState(false);
  const [reviewActionBusyId, setReviewActionBusyId] = useState<string | null>(null);
  const [reviewAllBusy, setReviewAllBusy] = useState(false);
  const [reviewPlanningAction, setReviewPlanningAction] = useState<{ messageId: string; action: ReviewAction } | null>(null);
  const [reviewActionDraft, setReviewActionDraft] = useState<{
    item: AiReviewAnalysisItem;
    suggestion: MessageActionSuggestion;
    initialAction: ReviewAction;
  } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [spamBusy, setSpamBusy] = useState(false);
  const [draggedMessage, setDraggedMessage] = useState<MessageSummary | null>(null);
  const [draggedMessageIds, setDraggedMessageIds] = useState<string[]>([]);
  const [messageListRevision, setMessageListRevision] = useState(0);
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
  const messageRequestRef = useRef(0);
  const messageListRequestRef = useRef(0);

  const readOnly = !session || session.role === "viewer";
  const isAdmin = session?.role === "admin";
  const isRenter = session?.user.role === "renter";
  const canUseMail = Boolean(session && !isRenter);
  const canAccessScreen = (screen: UserScreenId) => !session || userCanAccessScreen(session.user, screen);
  const navigateView = (next: AppView, replace = false) => {
    setViewMode(next);
    const path = next === "mail" ? "/mail" : `/${next}`;
    if (window.location.pathname !== path) {
      window.history[replace ? "replaceState" : "pushState"](null, "", path);
    }
  };

  useEffect(() => {
    const handlePopState = () => setViewMode(viewForPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!session) return;
    if (session.user.role === "renter" && viewMode !== "properties") {
      navigateView("properties", true);
      return;
    }
    if (viewMode === "calendar" && !canAccessScreen("calendar")) navigateView("mail", true);
    if (viewMode === "properties" && !canAccessScreen("properties")) navigateView("mail", true);
  }, [session, viewMode]);
  const selectedArchive = archives.find((archive) => archive.id === selectedArchiveId) ?? null;
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const searchFolderId = filters.folderId === ALL_MAIL_SEARCH_SCOPE
    ? null
    : filters.folderId || selectedFolderId;
  const visibleFolderId = searchFolderId;
  const visibleFolder = folders.find((folder) => folder.id === visibleFolderId) ?? null;
  const searchScopeLabel = filters.folderId === ALL_MAIL_SEARCH_SCOPE
    ? "Entire archive"
    : filters.folderId
      ? folders.find((folder) => folder.id === filters.folderId)?.path ?? "Selected mailbox"
      : selectedFolder?.path ?? "All mail";
  const showInboxCategories = visibleFolder?.name.trim().toLowerCase() === "inbox"
    && selectedSmartMailbox === null;
  const activeFilterCount = Object.values(filters).filter((value) => value !== "" && value !== undefined).length;

  const showError = useCallback((value: string) => {
    setNotice(value);
    window.setTimeout(() => setNotice((current) => current === value ? "" : current), 5_000);
  }, []);

  const updateMessageIndicators = useCallback((
    messageId: string,
    patch: { hasAiAnalysis?: boolean; hasCalendarEvent?: boolean; hasPendingFollowUp?: boolean }
  ) => {
    setItems((current) => current.map((item) => item.message.id === messageId
      ? { ...item, message: { ...item.message, ...patch } }
      : item));
    setMessage((current) => current?.id === messageId ? { ...current, ...patch } : current);
  }, []);

  const refreshStockQuotes = useCallback(async (client: ApiClient) => {
    setStockQuotesLoading(true);
    setStockQuotesError("");
    try {
      const [quotes, displaySettings] = await Promise.all([
        client.stockQuotes(),
        client.stockDisplaySettings().catch(() => null)
      ]);
      setStockQuotes(quotes);
      if (displaySettings) setStockSecondsPerSymbol(displaySettings.secondsPerSymbol);
    } catch (error) {
      setStockQuotesError(error instanceof Error ? error.message : "Market prices are unavailable");
    } finally {
      setStockQuotesLoading(false);
    }
  }, []);

  const refreshNewsHeadlines = useCallback(async (client: ApiClient) => {
    setNewsHeadlinesLoading(true);
    setNewsHeadlinesError("");
    try {
      const [headlines, displaySettings] = await Promise.all([
        client.newsHeadlines(),
        client.newsDisplaySettings().catch(() => null)
      ]);
      setNewsHeadlines(headlines);
      if (displaySettings) setNewsSecondsPerHeadline(displaySettings.secondsPerHeadline);
    } catch (error) {
      setNewsHeadlinesError(error instanceof Error ? error.message : "Headlines are unavailable");
    } finally {
      setNewsHeadlinesLoading(false);
    }
  }, []);

  const loadAuthenticatedData = useCallback(async (
    client: ApiClient,
    accountRole: AuthSessionInfo["user"]["role"]
  ) => {
    if (accountRole === "renter") {
      setArchives([]);
      setSelectedArchiveId(null);
      setViewMode("properties");
      if (window.location.pathname !== "/properties") window.history.replaceState(null, "", "/properties");
      return;
    }
    const loadedArchives = await client.listArchives();
    void refreshStockQuotes(client);
    void refreshNewsHeadlines(client);
    void client.flushClientDiagnostics().then(() => {
      setPendingDiagnosticCount(client.pendingDiagnosticCount());
    });
    setArchives(loadedArchives);
    setSelectedArchiveId((current) => (
      current && loadedArchives.some((archive) => archive.id === current)
        ? current
        : loadedArchives[0]?.id ?? null
    ));
  }, [refreshStockQuotes, refreshNewsHeadlines]);

  useEffect(() => {
    if (!api || !session || session.user.role === "renter") return;
    const timer = window.setInterval(() => void refreshStockQuotes(api), 60_000);
    return () => window.clearInterval(timer);
  }, [api, session, refreshStockQuotes]);

  useEffect(() => {
    if (!api || !session || session.user.role === "renter") return;
    const timer = window.setInterval(() => void refreshNewsHeadlines(api), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [api, session, refreshNewsHeadlines]);

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
      if (savedToken) client.setAccessToken(savedToken);
      try {
        const activeSession = await client.currentSession();
        setSession(activeSession);
        await loadAuthenticatedData(client, activeSession.user.role);
      } catch {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        client.setAccessToken("");
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
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      setSession(result.session);
      await loadAuthenticatedData(api, result.session.user.role);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const signOutLocally = () => {
    messageRequestRef.current += 1;
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
    try {
      window.localStorage.setItem(SHOW_READ_STORAGE_KEY, String(showReadMessages));
    } catch {}
  }, [showReadMessages]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FOLDER_PANEL_STORAGE_KEY, String(folderPanelVisible));
    } catch {}
  }, [folderPanelVisible]);

  useEffect(() => {
    setFilters((current) => current.folderId && current.folderId !== ALL_MAIL_SEARCH_SCOPE
      ? { ...current, folderId: "" }
      : current);
  }, [selectedArchiveId]);

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

  const importScreenAllowed = !session || userCanAccessScreen(session.user, "import");

  const refreshJobs = useCallback(async () => {
    if (!api || readOnly || !importScreenAllowed) return;
    try {
      const loaded = await api.listImportJobs();
      setJobs(loaded);
      if (loaded.some((job) => job.status === "running" || job.status === "queued")) {
        await refreshArchives();
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import status could not be loaded");
    }
  }, [api, readOnly, importScreenAllowed, refreshArchives, showError]);

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
        if (!active) return;
        setFolders(loaded);
        setSelectedFolderId((current) => {
          if (current && loaded.some((folder) => folder.id === current)) return current;
          return loaded.find((folder) => folder.name.trim().toLowerCase() === "inbox")?.id ?? null;
        });
      })
      .catch((error) => showError(error instanceof Error ? error.message : "Folders could not be loaded"));
    return () => { active = false; };
  }, [api, selectedArchiveId, showError]);

  useEffect(() => {
    if (!api || !selectedArchiveId) {
      setInboxTabSettings(defaultInboxTabSettings());
      return;
    }
    let active = true;
    setInboxTabSettings(defaultInboxTabSettings(selectedArchiveId));
    void api.inboxTabSettings(selectedArchiveId)
      .then((settings) => {
        if (!active) return;
        setInboxTabSettings(settings);
        setInboxCategory((current) => settings.tabs.some((tab) => tab.id === current && tab.enabled)
          ? current
          : "primary");
      })
      .catch((error) => showError(error instanceof Error ? error.message : "Inbox tabs could not be loaded"));
    return () => { active = false; };
  }, [api, selectedArchiveId, showError]);

  const loadMessages = useCallback(async (append = false) => {
    const requestId = ++messageListRequestRef.current;
    if (!api || !selectedArchiveId) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    setLoadingMessages(true);
    try {
      const countsPromise = !append && showInboxCategories
        ? api.inboxCategoryCounts({
            archiveId: selectedArchiveId,
            folderId: visibleFolderId ?? undefined,
            isRead: showReadMessages ? undefined : false
          })
        : Promise.resolve(null);
      if (searchTerm) {
        const searchFilters: SearchFilters = {
          archiveId: selectedArchiveId,
          folderId: searchFolderId ?? undefined,
          isRead: showReadMessages ? undefined : false,
          starred: selectedSmartMailbox === "starred" ? true : undefined,
          inboxCategory: showInboxCategories ? inboxCategory : undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          after: filters.after || undefined,
          before: filters.before || undefined,
          hasAttachment: filters.hasAttachment,
          sort,
          cursor: append ? nextCursor ?? undefined : undefined,
          limit: 50
        };
        const [page, counts] = await Promise.all([api.search(searchTerm, searchFilters), countsPromise]);
        if (requestId !== messageListRequestRef.current) return;
        setItems((current) => append
          ? [...current, ...page.items.map(hitToItem)]
          : page.items.map(hitToItem));
        setNextCursor(page.nextCursor);
        if (counts) setInboxCategoryCounts(counts);
      } else {
        const [page, counts] = await Promise.all([api.listMessages({
          archiveId: selectedArchiveId,
          folderId: searchFolderId ?? undefined,
          isRead: showReadMessages ? undefined : false,
          starred: selectedSmartMailbox === "starred" ? true : undefined,
          inboxCategory: showInboxCategories ? inboxCategory : undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          after: filters.after || undefined,
          before: filters.before || undefined,
          hasAttachment: filters.hasAttachment,
          cursor: append ? nextCursor ?? undefined : undefined,
          limit: 50
        }), countsPromise]);
        if (requestId !== messageListRequestRef.current) return;
        setItems((current) => append
          ? [...current, ...page.items.map(messageToItem)]
          : page.items.map(messageToItem));
        setNextCursor(page.nextCursor);
        if (counts) setInboxCategoryCounts(counts);
      }
      if (!showInboxCategories) setInboxCategoryCounts(EMPTY_INBOX_CATEGORY_COUNTS);
    } catch (error) {
      if (requestId !== messageListRequestRef.current) return;
      showError(error instanceof Error ? error.message : "Messages could not be loaded");
    } finally {
      if (requestId === messageListRequestRef.current) setLoadingMessages(false);
    }
  }, [
    api,
    selectedArchiveId,
    selectedFolderId,
    searchFolderId,
    visibleFolderId,
    selectedSmartMailbox,
    showInboxCategories,
    inboxCategory,
    searchTerm,
    filters,
    sort,
    showReadMessages,
    nextCursor,
    showError
  ]);

  useEffect(() => {
    messageRequestRef.current += 1;
    setItems([]);
    setNextCursor(null);
    setSelectedMessageId(null);
    setMessage(null);
    setBulkSelectedIds(new Set());
    void loadMessages(false);
  }, [api, selectedArchiveId, selectedFolderId, selectedSmartMailbox, searchTerm, filters, sort, inboxCategory, showReadMessages, messageListRevision]);

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
    const handleResult = (result: GmailOAuthResult | null | undefined) => {
      if (!result || result.type !== "archive-mail-gmail-oauth") return;
      const message = result.message ?? (result.success === false
        ? "Google authorization failed"
        : "Google account connected");
      if (result.success === false) setGmailError(message);
      else {
        setGmailError("");
        void refreshGmailConnections(false);
      }
      showError(message);
    };
    const handleGmailAuthorization = (event: MessageEvent<GmailOAuthResult>) => {
      if (event.origin !== window.location.origin) return;
      handleResult(event.data);
    };
    const handleStoredAuthorization = (event: StorageEvent) => {
      if (event.key !== GMAIL_OAUTH_RESULT_KEY || !event.newValue) return;
      try {
        handleResult(JSON.parse(event.newValue) as GmailOAuthResult);
      } catch {
        // Ignore malformed cross-window notifications.
      }
    };
    window.addEventListener("message", handleGmailAuthorization);
    window.addEventListener("storage", handleStoredAuthorization);
    return () => {
      window.removeEventListener("message", handleGmailAuthorization);
      window.removeEventListener("storage", handleStoredAuthorization);
    };
  }, [refreshGmailConnections, showError]);

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

  const closeMessage = useCallback(() => {
    messageRequestRef.current += 1;
    setSelectedMessageId(null);
    setMessage(null);
    setLoadingMessage(false);
    setMobileView("messages");
  }, []);

  const openMessage = async (summary: Pick<MessageSummary, "id">, moveMobile = true) => {
    if (!api) return;
    const requestId = ++messageRequestRef.current;
    setSelectedMessageId(summary.id);
    setMessage(null);
    if (moveMobile) setMobileView("reader");
    setLoadingMessage(true);
    try {
      const detail = await api.getMessage(summary.id);
      if (requestId !== messageRequestRef.current) return;
      setMessage(detail);
      if (!readOnly && !detail.state.isRead) {
        const state = await api.updateMessageState(detail.id, { isRead: true });
        if (requestId !== messageRequestRef.current) return;
        mergeMessageState(detail.id, state);
        void refreshMailboxCounts();
      }
    } catch (error) {
      if (requestId !== messageRequestRef.current) return;
      showError(error instanceof Error ? error.message : "Message could not be opened");
      closeMessage();
    } finally {
      if (requestId === messageRequestRef.current) setLoadingMessage(false);
    }
  };

  const mergeMessageState = (
    messageId: string,
    state: MessageDetail["state"]
  ) => {
    setMessage((current) => current?.id === messageId ? { ...current, state } : current);
    setItems((current) => current.flatMap((item) => {
      if (item.message.id !== messageId) return [item];
      if (!showReadMessages && state.isRead) return [];
      return [{
        ...item,
        message: { ...item.message, state },
        hit: item.hit ? { ...item.hit, message: { ...item.hit.message, state } } : undefined
      }];
    }));
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
    setInboxCategory("primary");
    closeMessage();
  };

  const selectFolder = (id: string | null) => {
    setSelectedFolderId(id);
    setSelectedSmartMailbox(null);
    setInboxCategory("primary");
    closeMessage();
  };

  const selectInboxCategory = (category: InboxCategory) => {
    setInboxCategory(category);
    closeMessage();
  };

  const selectSmartMailbox = (mailbox: SmartMailbox) => {
    setSelectedFolderId(null);
    setSelectedSmartMailbox(mailbox);
    closeMessage();
  };

  const openImport = () => {
    // Also reached from the Sidebar's import buttons, so guard here rather
    // than only hiding the top-bar entry point.
    if (!canAccessScreen("import")) {
      showError("Import access is disabled for this account. Ask an administrator to enable it.");
      return;
    }
    setImportProgress(null);
    setImportError("");
    setImportOpen(true);
  };

  const startImport = async (file: File | null, ocrEnabled: boolean) => {
    if (!api || readOnly) return;
    setImportBusy(true);
    setImportError("");
    setImportProgress(null);
    const controller = file ? new AbortController() : null;
    importAbortRef.current = controller;
    try {
      const job = file ? await api.uploadArchive(file, ocrEnabled, setImportProgress, controller?.signal) : null;
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
      const job = await api.cancelImport(jobId);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Import could not be cancelled");
    }
  };

  const resumeJob = async (jobId: string) => {
    if (!api) return;
    try {
      const job = await api.resumeImport(jobId);
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
      if (api) await api.removeArchive(archiveId);
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
      setCreateMailboxParentId(null);
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
      setMessageListRevision((current) => current + 1);
      showError(
        `${result.movedMessages.toLocaleString()} messages and ${result.movedAttachments.toLocaleString()} attachments combined into ${result.mailbox.path}`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Mailboxes could not be combined");
    } finally {
      setCombineMailboxBusy(false);
    }
  };

  const organizeDroppedMailbox = async (action: "merge" | "child") => {
    if (!api || !mailboxDrop || readOnly) return;
    setMailboxDropBusy(true);
    try {
      if (action === "merge") {
        const result = await api.combineMailboxes(mailboxDrop.source.id, mailboxDrop.target.id);
        setSelectedArchiveId(result.mailbox.archiveId);
        setSelectedFolderId(result.mailbox.id);
        showError(
          `${result.movedMessages.toLocaleString()} messages combined into ${result.mailbox.path}`
        );
      } else {
        const result = await api.moveMailbox(mailboxDrop.source.id, mailboxDrop.target.id);
        setSelectedArchiveId(result.mailbox.archiveId);
        setSelectedFolderId(result.mailbox.id);
        showError(
          `${result.mailbox.path} moved with ${result.movedMailboxes.toLocaleString()} mailbox${result.movedMailboxes === 1 ? "" : "es"}`
        );
      }
      setSelectedMessageId(null);
      setMessage(null);
      const archiveId = mailboxDrop.source.archiveId;
      setMailboxDrop(null);
      setFolders(await api.listFolders(archiveId));
      await refreshArchives();
      setMessageListRevision((current) => current + 1);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Mailbox could not be organized");
    } finally {
      setMailboxDropBusy(false);
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

  const aiScreenAllowed = !session || userCanAccessScreen(session.user, "ai");

  const refreshReviewQueue = useCallback(async () => {
    if (!api || !aiScreenAllowed) return;
    setReviewQueueLoading(true);
    try {
      setReviewQueue(await api.getAiReviewQueue());
    } catch (error) {
      showError(error instanceof Error ? error.message : "AI review queue could not be loaded");
    } finally {
      setReviewQueueLoading(false);
    }
  }, [api, aiScreenAllowed, showError]);

  useEffect(() => {
    if (!api || !session || !aiScreenAllowed) return;
    void refreshReviewQueue();
    const interval = window.setInterval(() => void refreshReviewQueue(), 30_000);
    return () => window.clearInterval(interval);
  }, [api, session?.id, aiScreenAllowed, refreshReviewQueue]);

  const openReviewQueue = () => {
    setReviewQueueOpen(true);
    void refreshReviewQueue();
  };

  const completeReviewFollowUp = async (followUpId: string, messageId: string) => {
    if (!api || readOnly) return;
    setReviewActionBusyId(followUpId);
    try {
      await api.updateFollowUp(followUpId, { status: "completed" });
      updateMessageIndicators(messageId, { hasPendingFollowUp: false });
      await refreshReviewQueue();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Follow-up could not be completed");
    } finally {
      setReviewActionBusyId(null);
    }
  };

  const deleteReviewDraft = async (draft: EmailDraft) => {
    if (!api || readOnly || !window.confirm(`Delete the draft "${draft.subject || "(No subject)"}"?`)) return;
    setReviewActionBusyId(draft.id);
    try {
      await api.deleteDraft(draft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
      await refreshReviewQueue();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Draft could not be deleted");
    } finally {
      setReviewActionBusyId(null);
    }
  };

  const markReviewAnalysisReviewed = async (item: AiReviewAnalysisItem) => {
    if (!api || readOnly) return;
    setReviewActionBusyId(item.message.id);
    try {
      await api.markMessageAnalysisReviewed(item.message.id);
      await refreshReviewQueue();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be marked reviewed");
    } finally {
      setReviewActionBusyId(null);
    }
  };

  const markAllReviewAnalysesReviewed = async () => {
    if (!api || readOnly || !reviewQueue?.analyses.length) return;
    if (!window.confirm("Mark every message in Needs attention as reviewed? This will hide them from the AI review queue.")) return;
    setReviewAllBusy(true);
    try {
      const result = await api.markAllMessageAnalysesReviewed();
      await refreshReviewQueue();
      showError(result.reviewedCount === 0
        ? "No messages needed review."
        : `Marked ${result.reviewedCount.toLocaleString()} ${result.reviewedCount === 1 ? "message" : "messages"} reviewed.`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Messages could not be marked reviewed");
    } finally {
      setReviewAllBusy(false);
    }
  };

  const createReviewAnalysisAction = async (item: AiReviewAnalysisItem, action: ReviewAction) => {
    if (!api || readOnly) return;
    setReviewPlanningAction({ messageId: item.message.id, action });
    try {
      const suggestion = await api.suggestMessageAction(item.message.id, {
        now: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      });
      setReviewActionDraft({ item, suggestion, initialAction: action });
    } catch (error) {
      showError(error instanceof Error ? error.message : "AI could not prepare the action");
    } finally {
      setReviewPlanningAction(null);
    }
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

  const openGeneratedDraft = (draft: EmailDraft) => {
    setDrafts((current) => current.some((entry) => entry.id === draft.id)
      ? current.map((entry) => entry.id === draft.id ? draft : entry)
      : [draft, ...current]);
    editSavedDraft(draft);
  };

  const deleteSavedDraft = async (draft: EmailDraft) => {
    if (!api || !window.confirm(`Delete the draft "${draft.subject || "(No subject)"}"?`)) return;
    setDraftsBusy(true);
    setDraftsError("");
    try {
      await api.deleteDraft(draft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
      await refreshReviewQueue();
    } catch (error) {
      setDraftsError(error instanceof Error ? error.message : "Draft could not be deleted");
    } finally {
      setDraftsBusy(false);
    }
  };

  const deleteOpenDraft = async () => {
    if (!api || readOnly || !composeDraft?.id || !window.confirm(`Delete the draft "${composeDraft.subject || "(No subject)"}"?`)) return;
    setComposeBusy(true);
    setComposeError("");
    try {
      await api.deleteDraft(composeDraft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== composeDraft.id));
      setComposeOpen(false);
      setComposeDraft(null);
      await refreshReviewQueue();
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : "Draft could not be deleted");
    } finally {
      setComposeBusy(false);
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
      await refreshReviewQueue();
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
      sourceMessageId: mode === "reply" ? target.id : null,
      to: mode === "reply" ? target.sender.address : "",
      subject,
      bodyText: quoted
    });
  };

  const moveMessage = async (messageId: string, folderId: string) => {
    if (!api || readOnly) return;
    const source = message?.id === messageId
      ? message
      : items.find((item) => item.message.id === messageId)?.message ?? draggedMessage;
    setMoveBusy(true);
    try {
      let destination = folders.find((folder) => folder.id === folderId) ?? null;
      if (!destination && source) {
        const availableFolders = await api.listFolders(source.archiveId);
        destination = availableFolders.find((folder) => folder.id === folderId) ?? null;
        if (source.archiveId === selectedArchiveId) setFolders(availableFolders);
      }
      const senderAddress = source?.sender.address.trim() ?? "";
      const isSpamDestination = destination
        ? ["spam", "junk"].includes(destination.name.trim().toLowerCase())
        : false;
      if (isSpamDestination) {
        if (!window.confirm(
          `Move this message and every Inbox message from ${senderAddress || "this sender"} to Spam, and automatically send future imported Inbox messages from this sender to Spam? If Gmail mailbox sync is enabled, current Gmail messages move too.`
        )) return;
        const result = await api.markSenderAsSpam(messageId);
        if (message?.id === messageId) setMessage(result.message);
        await Promise.all([
          refreshArchives(),
          loadMessages(false),
          selectedArchiveId ? api.listFolders(selectedArchiveId).then(setFolders) : Promise.resolve()
        ]);
        showError(
          `${result.senderAddress} will now go to ${result.spamFolderPath}. Moved ${result.movedMessages.toLocaleString()} matching message${result.movedMessages === 1 ? "" : "s"}.`
        );
        return;
      }
      const moveAllFromSender = Boolean(senderAddress && destination) && window.confirm(
        `Move every email from ${senderAddress} to ${destination?.path}, including messages outside the current list? Future incoming Inbox email from this sender will also be filed there. If Gmail mailbox sync is enabled, current Gmail messages move too.\n\nChoose OK to move all sender email, or Cancel to move only this email.`
      );
      const result = moveAllFromSender
        ? await api.moveSenderMessagesToFolder(messageId, folderId)
        : null;
      const moved = result?.message ?? await api.moveMessage(messageId, folderId);
      if (message?.id === messageId) setMessage(moved);
      await Promise.all([
        refreshArchives(),
        loadMessages(false),
        selectedArchiveId ? api.listFolders(selectedArchiveId).then(setFolders) : Promise.resolve()
      ]);
      showError(result
        ? `Moved ${result.movedMessages.toLocaleString()} email${result.movedMessages === 1 ? "" : "s"} from ${result.senderAddress} to ${result.folderPath}. Future Inbox email from this sender will be filed there.`
        : `Moved to ${moved.folderPath}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message could not be moved");
    } finally {
      setMoveBusy(false);
    }
  };

  const archiveMessage = async (target: MessageSummary) => {
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

  const spamSender = async (target: MessageSummary) => {
    if (!api || readOnly) return;
    const senderAddress = target.sender.address.trim();
    if (!senderAddress) {
      showError("This message does not have a sender address");
      return;
    }
    if (!window.confirm(
      `Move this message and every Inbox message from ${senderAddress} to Spam, including messages not currently loaded, and automatically file future imported Inbox messages from this sender there? If Gmail mailbox sync is enabled, current Gmail messages move too. Other messages outside Inbox will remain unchanged.`
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
        `${senderAddress} will now go to ${result.spamFolderPath}. Moved ${result.movedMessages.toLocaleString()} matching message${result.movedMessages === 1 ? "" : "s"}, including every Inbox match outside the current list.`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Sender could not be marked as spam");
    } finally {
      setSpamBusy(false);
    }
  };

  const toggleListMessageRead = async (target: MessageSummary) => {
    if (!api || readOnly) return;
    try {
      const state = await api.updateMessageState(target.id, { isRead: !target.state.isRead });
      setItems((current) => current.map((entry) => entry.message.id === target.id
        ? { ...entry, message: { ...entry.message, state } }
        : entry));
      setMessage((current) => current?.id === target.id ? { ...current, state } : current);
      await refreshMailboxCounts();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Message state could not be updated");
    }
  };

  const toggleBulkSelect = (messageId: string) => {
    setBulkSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
      return next;
    });
  };

  const toggleBulkSelectAll = () => {
    setBulkSelectedIds((current) => {
      const allVisibleSelected = items.length > 0 && items.every((item) => current.has(item.message.id));
      return allVisibleSelected ? new Set() : new Set(items.map((item) => item.message.id));
    });
  };

  const selectFirstLoadedMessages = (count: number) => {
    setBulkSelectedIds(new Set(items.slice(0, count).map((item) => item.message.id)));
  };

  const selectAllLoadedMessages = () => {
    setBulkSelectedIds(new Set(items.map((item) => item.message.id)));
  };

  const selectEntireMessageView = async () => {
    if (!api || !selectedArchiveId || readOnly) return;
    if (!nextCursor) {
      selectAllLoadedMessages();
      showError(`Selected all ${items.length.toLocaleString()} messages in this view`);
      return;
    }

    setSelectionBusy(true);
    try {
      const selected = new Set<string>();
      let cursor: string | undefined;
      do {
        const limit = Math.min(100, MAX_BULK_SELECTION - selected.size);
        if (searchTerm) {
          const page = await api.search(searchTerm, {
            archiveId: selectedArchiveId,
            folderId: searchFolderId ?? undefined,
            isRead: showReadMessages ? undefined : false,
            starred: selectedSmartMailbox === "starred" ? true : undefined,
            inboxCategory: showInboxCategories ? inboxCategory : undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
            after: filters.after || undefined,
            before: filters.before || undefined,
            hasAttachment: filters.hasAttachment,
            sort,
            cursor,
            limit
          });
          page.items.forEach((hit) => selected.add(hit.message.id));
          cursor = page.nextCursor ?? undefined;
        } else {
          const page = await api.listMessages({
            archiveId: selectedArchiveId,
            folderId: searchFolderId ?? undefined,
            isRead: showReadMessages ? undefined : false,
            starred: selectedSmartMailbox === "starred" ? true : undefined,
            inboxCategory: showInboxCategories ? inboxCategory : undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
            after: filters.after || undefined,
            before: filters.before || undefined,
            hasAttachment: filters.hasAttachment,
            cursor,
            limit
          });
          page.items.forEach((entry) => selected.add(entry.id));
          cursor = page.nextCursor ?? undefined;
        }
      } while (cursor && selected.size < MAX_BULK_SELECTION);

      setBulkSelectedIds(selected);
      showError(cursor
        ? `Selected the first ${selected.size.toLocaleString()} messages. Bulk actions are limited to ${MAX_BULK_SELECTION.toLocaleString()} at a time.`
        : `Selected all ${selected.size.toLocaleString()} messages in this view`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Messages could not be selected");
    } finally {
      setSelectionBusy(false);
    }
  };

  const clearBulkSelection = () => setBulkSelectedIds(new Set());

  const bulkMarkRead = async () => {
    if (!api || readOnly || bulkSelectedIds.size === 0) return;
    const messageIds = [...bulkSelectedIds];
    setBulkActionBusy(true);
    try {
      const result = await api.bulkMarkMessagesRead(messageIds);
      if (message && messageIds.includes(message.id)) {
        if (showReadMessages) {
          setMessage({ ...message, state: { ...message.state, isRead: true } });
        } else {
          setSelectedMessageId(null);
          setMessage(null);
        }
      }
      setBulkSelectedIds(new Set());
      await Promise.all([refreshMailboxCounts(), loadMessages(false)]);
      showError(
        `Marked ${result.updated.toLocaleString()} message${result.updated === 1 ? "" : "s"} as read`
        + (result.alreadyRead ? `; ${result.alreadyRead.toLocaleString()} already read` : "")
        + (result.failed ? `; ${result.failed.toLocaleString()} could not be updated` : "")
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Selected messages could not be marked read");
    } finally {
      setBulkActionBusy(false);
    }
  };

  const bulkMove = async (destination: BulkMoveDestination) => {
    if (!api || readOnly || bulkSelectedIds.size === 0) return;
    const messageIds = [...bulkSelectedIds];
    const { verb, noun } = BULK_MOVE_LABELS[destination];
    const confirmation = destination === "spam"
      ? `Move the selected messages to Spam, move every matching Inbox message from their senders, and automatically send future imported Inbox messages from those senders to Spam? If Gmail mailbox sync is enabled, current Gmail messages move too.`
      : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${messageIds.length.toLocaleString()} selected message${messageIds.length === 1 ? "" : "s"}? They will be moved to ${noun}.`;
    if (!window.confirm(confirmation)) return;
    setBulkActionBusy(true);
    try {
      const result = await api.bulkMoveMessages(messageIds, destination);
      if (message && messageIds.includes(message.id)) {
        setSelectedMessageId(null);
        setMessage(null);
      }
      setBulkSelectedIds(new Set());
      await Promise.all([
        refreshArchives(),
        loadMessages(false),
        selectedArchiveId ? api.listFolders(selectedArchiveId).then(setFolders) : Promise.resolve()
      ]);
      showError(destination === "spam"
        ? `Moved ${result.moved.toLocaleString()} matching message${result.moved === 1 ? "" : "s"} to ${result.folderPaths.join(", ") || noun}; enabled ${result.senderRules.toLocaleString()} sender rule${result.senderRules === 1 ? "" : "s"}`
          + (result.failed ? `; ${result.failed.toLocaleString()} could not be processed` : "")
        : `Moved ${result.moved.toLocaleString()} message${result.moved === 1 ? "" : "s"} to ${result.folderPaths.join(", ") || noun}`
          + (result.failed ? `, ${result.failed} could not be moved` : ""));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Selected messages could not be moved");
    } finally {
      setBulkActionBusy(false);
    }
  };

  const bulkAiFile = async () => {
    if (!api || readOnly || bulkSelectedIds.size === 0) return;
    const messageIds = [...bulkSelectedIds];
    setBulkActionBusy(true);
    setAiFilingBusy(true);
    try {
      const suggestion = await api.suggestBulkFilingFolder(messageIds);
      if (!suggestion.folderId || !suggestion.folderPath) {
        showError(`AI did not find one folder for this selection: ${suggestion.reason}`);
        return;
      }
      const confidence = Math.round(suggestion.confidence * 100);
      const accepted = window.confirm(
        `AI recommends moving ${messageIds.length.toLocaleString()} selected message${messageIds.length === 1 ? "" : "s"} to "${suggestion.folderPath}".\n\n`
        + `Confidence: ${confidence}%\n${suggestion.reason}\n\nMove all selected messages to this folder?`
      );
      if (!accepted) return;
      // Snapshot before the refresh below removes the moved rows from the list.
      const movedSummaries = items
        .filter((item) => messageIds.includes(item.message.id))
        .map((item) => item.message);
      const result = await api.bulkMoveMessagesToFolder(messageIds, suggestion.folderId);
      if (message && messageIds.includes(message.id)) {
        setSelectedMessageId(null);
        setMessage(null);
      }
      setBulkSelectedIds(new Set());
      await Promise.all([
        refreshArchives(),
        loadMessages(false),
        selectedArchiveId ? api.listFolders(selectedArchiveId).then(setFolders) : Promise.resolve()
      ]);
      showError(
        `AI filed ${result.moved.toLocaleString()} message${result.moved === 1 ? "" : "s"} in ${result.folderPath}`
        + (result.alreadyThere ? `; ${result.alreadyThere.toLocaleString()} already there` : "")
        + (result.failed ? `; ${result.failed.toLocaleString()} could not be moved` : "")
      );
      await offerSmartRuleForFiling(movedSummaries, suggestion);
    } catch (error) {
      showError(error instanceof Error ? error.message : "AI could not recommend a mailbox");
    } finally {
      setAiFilingBusy(false);
      setBulkActionBusy(false);
    }
  };

  // After an accepted AI filing move, offer to turn the decision into a smart
  // rule and sweep every folder with it, so similar mail is filed the same way
  // from now on.
  const offerSmartRuleForFiling = async (movedMessages: MessageSummary[], filing: MessageFilingSuggestion) => {
    if (!api || !filing.folderId || !filing.folderPath) return;
    if (!isAdmin && !canAccessScreen("settings")) return;
    const archiveId = movedMessages[0]?.archiveId ?? selectedArchiveId;
    if (!archiveId || movedMessages.some((moved) => moved.archiveId !== archiveId)) return;
    if (!window.confirm(
      `Create a smart rule so emails like these are filed to "${filing.folderPath}" automatically?\n\n`
      + "AI will draft the rule for your review, and you can apply it to every folder right away."
    )) return;

    try {
      const senders = [...new Set(movedMessages.map((moved) => moved.sender.address).filter(Boolean))].slice(0, 10);
      const subjects = [...new Set(movedMessages.map((moved) => moved.subject).filter(Boolean))].slice(0, 5);
      const instruction = [
        `Move emails like the following to the folder "${filing.folderPath}".`,
        senders.length ? `They come from senders such as: ${senders.join(", ")}.` : "",
        subjects.length ? `Subjects look like: ${subjects.map((subject) => `"${subject}"`).join("; ")}.` : "",
        filing.reason ? `They were filed there because: ${filing.reason}` : ""
      ].filter(Boolean).join("\n").slice(0, 4_000);
      const draft = await api.suggestSmartMailRule({ archiveId, instruction });
      const conditionParts = [
        draft.conditions.senderContains.length ? `sender contains ${draft.conditions.senderContains.join(", ")}` : "",
        draft.conditions.subjectContains.length ? `subject contains ${draft.conditions.subjectContains.join(", ")}` : "",
        draft.conditions.bodyContains.length ? `body contains ${draft.conditions.bodyContains.join(", ")}` : "",
        draft.conditions.hasAttachments === null ? "" : draft.conditions.hasAttachments ? "has attachments" : "has no attachments"
      ].filter(Boolean).join(draft.conditions.match === "all" ? " AND " : " OR ");
      if (!window.confirm(
        `AI drafted this rule:\n\n"${draft.name}"\nWhen ${conditionParts || "…"}\nMove to "${filing.folderPath}"\n\n`
        + `${draft.explanation}\n\nCreate the rule and apply it to every folder now?`
      )) return;
      const rule = await api.createSmartMailRule({
        archiveId,
        name: draft.name,
        instruction,
        conditions: draft.conditions,
        targetFolderId: filing.folderId,
        markRead: draft.markRead,
        star: draft.star,
        enabled: true,
        applyExisting: false
      });
      await api.runSmartMailRule(rule.id, "all");
      showError(
        `Smart rule "${rule.name}" created. It is sweeping every folder in the background and will file future mail automatically (manage it under Settings → Smart rules).`
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "The smart rule could not be created");
    }
  };

  const moveSelectedMessagesToFolder = async (messageIds: string[], folderId: string) => {
    if (!api || readOnly || messageIds.length === 0) return;
    const destination = folders.find((folder) => folder.id === folderId);
    if (!destination) {
      showError("Destination mailbox could not be found");
      return;
    }
    const isSpamDestination = ["spam", "junk"].includes(destination.name.trim().toLowerCase());
    const confirmation = isSpamDestination
      ? `Move the selected messages to Spam, move every matching Inbox message from their senders, and automatically send future imported Inbox messages from those senders to Spam? If Gmail mailbox sync is enabled, current Gmail messages move too.`
      : `Move ${messageIds.length.toLocaleString()} selected messages to ${destination.path}? If Gmail mailbox sync is enabled, the Gmail messages move too.`;
    if (!window.confirm(confirmation)) return;

    setMoveBusy(true);
    try {
      const result = isSpamDestination
        ? await api.bulkMoveMessages(messageIds, "spam")
        : await api.bulkMoveMessagesToFolder(messageIds, folderId);
      if (message && messageIds.includes(message.id)) {
        setSelectedMessageId(null);
        setMessage(null);
      }
      setBulkSelectedIds(new Set());
      await Promise.all([
        refreshArchives(),
        loadMessages(false),
        selectedArchiveId ? api.listFolders(selectedArchiveId).then(setFolders) : Promise.resolve()
      ]);
      showError("folderPaths" in result
        ? `Moved ${result.moved.toLocaleString()} matching message${result.moved === 1 ? "" : "s"} to ${result.folderPaths.join(", ") || destination.path}; enabled ${result.senderRules.toLocaleString()} sender rule${result.senderRules === 1 ? "" : "s"}`
          + (result.alreadyThere ? `; ${result.alreadyThere.toLocaleString()} selected already there` : "")
          + (result.failed ? `; ${result.failed.toLocaleString()} could not be processed` : "")
        : `Moved ${result.moved.toLocaleString()} selected message${result.moved === 1 ? "" : "s"} to ${result.folderPath}`
          + (result.alreadyThere ? `; ${result.alreadyThere.toLocaleString()} already there` : "")
          + (result.failed ? `; ${result.failed.toLocaleString()} could not be moved` : ""));
    } catch (error) {
      showError(error instanceof Error ? error.message : "Selected messages could not be moved");
    } finally {
      setMoveBusy(false);
    }
  };

  const dropMessagesIntoFolder = (messageIds: string[], folderId: string) => {
    setDraggedMessage(null);
    setDraggedMessageIds([]);
    if (messageIds.length === 1) {
      void moveMessage(messageIds[0]!, folderId);
      return;
    }
    void moveSelectedMessagesToFolder(messageIds, folderId);
  };

  const connectGmail = async (request: GmailAuthRequest) => {
    if (!api || readOnly) return;
    setGmailBusy(true);
    setGmailError("");
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const authorization = await api.startGmailAuthorization(request);
      if (popup) popup.location.href = authorization.authorizationUrl;
      else window.open(authorization.authorizationUrl, "_blank", "noopener,noreferrer");
      showError("Finish Gmail authorization in your browser");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gmail authorization could not start";
      if (popup && !popup.closed) showGmailAuthorizationError(popup, message);
      setGmailError(message);
      showError(message);
    } finally {
      setGmailBusy(false);
    }
  };

  const reauthorizeGmail = (connection: GmailConnection) => {
    void connectGmail({
      connectionId: connection.id,
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
    try {
      const state = api ? await api.getSharingState() : EMPTY_SHARING;
      setSharing(state);
    } catch {
      setSharing(EMPTY_SHARING);
    }
  };

  const toggleSharing = async (enabled: boolean) => {
    setShareBusy(true);
    try {
      setSharing(api ? await api.setSharingEnabled(enabled) : EMPTY_SHARING);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Sharing could not be changed");
    } finally {
      setShareBusy(false);
    }
  };

  const listTitle = searchTerm
    ? `Search in ${searchScopeLabel}: ${searchTerm}`
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

  const invitationToken = window.location.pathname.startsWith("/portal/invite")
    ? new URLSearchParams(window.location.search).get("token")
    : null;
  if (!session && api && invitationToken) {
    return <TenantInvitationScreen api={api} token={invitationToken} onAccepted={(result) => {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      setSession(result.session);
      window.history.replaceState(null, "", "/properties");
      void loadAuthenticatedData(api, result.session.user.role);
    }} />;
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
          <span className="brand-name">{isRenter ? "Tenant Portal" : "Archive Mail"}</span>
          {viewMode === "mail" && (
            <button
              className="icon-button subtle folder-panel-toggle"
              onClick={() => setFolderPanelVisible((visible) => !visible)}
              title={folderPanelVisible ? "Hide folders" : "Show folders"}
              aria-label={folderPanelVisible ? "Hide folders" : "Show folders"}
              aria-controls="folder-sidebar"
              aria-expanded={folderPanelVisible}
            >
              {folderPanelVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
          )}
        </div>

        {viewMode === "mail" ? (
          <div className="search-wrap">
            <Search className="search-icon" size={18} />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search in ${searchScopeLabel}`}
              aria-label="Search mail and attachments"
            />
            {query && (
              <button className="search-clear" onClick={() => setQuery("")} title="Clear search" aria-label="Clear search">
                <X size={16} />
              </button>
            )}
          </div>
        ) : (
          <div className="module-context">
            {viewMode === "calendar" ? <CalendarDays size={18} /> : <Building2 size={18} />}
            <div><strong>{viewMode === "calendar" ? "Calendar" : "Property Management"}</strong><span>{viewMode === "calendar" ? "Events and to-dos" : "Portfolio and tenant portal"}</span></div>
          </div>
        )}

        <div className="topbar-actions">
          {viewMode === "mail" && searchTerm && (
            <div className="sort-segment" aria-label="Search sort">
              <button className={sort === "relevance" ? "selected" : ""} onClick={() => setSort("relevance")}>Best</button>
              <button className={sort === "newest" ? "selected" : ""} onClick={() => setSort("newest")}>Newest</button>
            </div>
          )}
          {viewMode === "mail" && <div className="filter-anchor">
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
              folders={folders}
              currentFolderLabel={selectedFolder?.path ?? "All mail"}
              onChange={setFilters}
              onClose={() => setFilterOpen(false)}
            />
          </div>}
          {viewMode === "mail" && <button
            className={`icon-button read-visibility-toggle ${showReadMessages ? "" : "active"}`}
            onClick={() => setShowReadMessages((current) => !current)}
            title={showReadMessages ? "Hide read emails in every folder" : "Show read emails in every folder"}
            aria-label={showReadMessages ? "Hide read emails in every folder" : "Show read emails in every folder"}
            aria-pressed={!showReadMessages}
          >
            {showReadMessages ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>}
          {canAccessScreen("calendar") && (
            <button
              className={`icon-button calendar-trigger ${viewMode === "calendar" ? "active" : ""}`}
              onClick={() => navigateView(viewMode === "calendar" ? "mail" : "calendar")}
              title={viewMode === "calendar" ? "Back to mail" : "Open calendar"}
              aria-label={viewMode === "calendar" ? "Back to mail" : "Open calendar"}
            >
              {viewMode === "calendar" ? <Mail size={18} /> : <CalendarDays size={18} />}
            </button>
          )}
          {!isRenter && canAccessScreen("properties") && (
            <button
              className={`icon-button properties-trigger ${viewMode === "properties" ? "active" : ""}`}
              onClick={() => navigateView(viewMode === "properties" ? "mail" : "properties")}
              title={viewMode === "properties" ? "Back to mail" : "Open property management"}
              aria-label={viewMode === "properties" ? "Back to mail" : "Open property management"}
            >
              {viewMode === "properties" ? <Mail size={18} /> : <Building2 size={18} />}
            </button>
          )}
          {isAdmin && (
            <button className="icon-button sharing-trigger" onClick={() => void openSharing()} title="Open iPhone viewer" aria-label="Open iPhone viewer">
              <MonitorSmartphone size={18} />
            </button>
          )}
          {!readOnly && canAccessScreen("compose") && (
            <button className="icon-button drafts-trigger" onClick={openDrafts} title="Open drafts" aria-label="Open drafts">
              <FileEdit size={18} />
            </button>
          )}
          {canAccessScreen("ai") && (
            <button className="icon-button review-queue-trigger" onClick={openReviewQueue} title="Open AI review queue" aria-label="Open AI review queue">
              <BrainCircuit size={18} />
              {(reviewQueue?.totalItems ?? 0) > 0 && <span className="diagnostic-count">{Math.min(99, reviewQueue!.totalItems)}</span>}
            </button>
          )}
          {!readOnly && canAccessScreen("compose") && (
            <button className="icon-button compose-trigger" onClick={() => openCompose()} title="Compose email" aria-label="Compose email">
              <MailPlus size={18} />
            </button>
          )}
          {!readOnly && (isAdmin || isRenter || canAccessScreen("settings")) && (
            <button className="icon-button settings-trigger" onClick={() => setSettingsOpen(true)} title={isAdmin ? "Open admin settings" : "Open personal settings"} aria-label={isAdmin ? "Open admin settings" : "Open personal settings"}>
              <SettingsIcon size={18} />
              {isAdmin && pendingDiagnosticCount > 0 && <span className="diagnostic-count">{Math.min(99, pendingDiagnosticCount)}</span>}
            </button>
          )}
          {!readOnly && canAccessScreen("import") && (
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

      <main className={`workspace ${viewMode === "mail" && selectedMessageId ? "reader-open" : ""} ${folderPanelVisible ? "" : "folders-collapsed"} ${viewMode === "properties" ? "property-workspace" : ""}`}>
        {viewMode === "calendar" ? (
          api && <CalendarView api={api} connections={gmailConnections} onReauthorize={reauthorizeGmail} onError={showError} />
        ) : viewMode === "properties" ? (
          api && (
            <Suspense fallback={<div className="property-loading"><LoaderCircle className="spin" size={24} /> Loading property workspace…</div>}>
              <PropertyManagementView api={api} readOnly={readOnly} isAdmin={isAdmin} onError={showError} onNotice={setNotice} />
            </Suspense>
          )
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
              draggedMessageIds={draggedMessageIds}
              moveBusy={moveBusy}
              folderBusy={combineMailboxBusy || mailboxDropBusy}
              onSelectArchive={selectArchive}
              onSelectFolder={selectFolder}
              onSelectSmartMailbox={selectSmartMailbox}
              onImport={openImport}
              onOpenGmail={openGmail}
              onCreateFolder={() => {
                setCreateMailboxParentId(selectedFolderId);
                setCreateMailboxOpen(true);
              }}
              onCombineArchive={setCombineSource}
              onCombineFolder={setCombineMailboxSource}
              onOrganizeFolder={(source, target) => setMailboxDrop({ source, target })}
              onCancelJob={(id) => void cancelJob(id)}
              onResumeJob={(id) => void resumeJob(id)}
              onClearJob={(id) => void clearJob(id)}
              onRemoveArchive={(id) => void removeArchive(id)}
              onRemoveFolder={(folder) => void removeFolder(folder)}
              onRenameArchive={(archive) => setRenameTarget({ kind: "archive", id: archive.id, name: archive.name })}
              onRenameFolder={(folder) => setRenameTarget({ kind: "mailbox", id: folder.id, archiveId: folder.archiveId, name: folder.name })}
              onMoveMessages={dropMessagesIntoFolder}
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
              onDragStart={(target, messageIds) => {
                setDraggedMessage(target);
                setDraggedMessageIds(messageIds);
              }}
              onDragEnd={() => {
                setDraggedMessage(null);
                setDraggedMessageIds([]);
              }}
              onLoadMore={() => void loadMessages(true)}
              onMobileBack={() => setMobileView("folders")}
              inboxCategories={showInboxCategories ? {
                active: inboxCategory,
                counts: inboxCategoryCounts,
                tabs: inboxTabSettings.tabs,
                onSelect: selectInboxCategory
              } : null}
              selectedIds={bulkSelectedIds}
              onToggleSelect={toggleBulkSelect}
              onToggleSelectAll={toggleBulkSelectAll}
              onSelectFirst={selectFirstLoadedMessages}
              onSelectLoaded={selectAllLoadedMessages}
              onSelectEntireView={() => void selectEntireMessageView()}
              onClearSelection={clearBulkSelection}
              selectionBusy={selectionBusy}
              bulkBusy={bulkActionBusy}
              onBulkDelete={() => void bulkMove("trash")}
              onBulkArchive={() => void bulkMove("archived")}
              onBulkSpam={() => void bulkMove("spam")}
              onBulkMarkRead={() => void bulkMarkRead()}
              onBulkAiFile={() => void bulkAiFile()}
              aiFilingBusy={aiFilingBusy}
              actionBusy={moveBusy || spamBusy}
              onArchive={(target) => void archiveMessage(target)}
              onSpam={(target) => void spamSender(target)}
              onToggleRead={(target) => void toggleListMessageRead(target)}
            />
            <MessageReader
              key={message?.id ?? "empty-reader"}
              message={message}
              loading={loadingMessage}
              readOnly={readOnly}
              api={api}
              connections={gmailConnections}
              onMobileBack={closeMessage}
              onUpdateState={updateState}
              onError={showError}
              onReply={(target) => openReply(target, "reply")}
              onForward={(target) => openReply(target, "forward")}
              onLoadFolders={loadFoldersForGmail}
              onMove={(messageId, folderId) => moveMessage(messageId, folderId)}
              onArchive={archiveMessage}
              onSpamSender={spamSender}
              onOpenDraft={openGeneratedDraft}
              onIndicatorsChange={updateMessageIndicators}
              moveBusy={moveBusy}
              spamBusy={spamBusy}
            />
          </>
        )}
      </main>

      {!isRenter && <NewsTickerBar
        headlines={newsHeadlines}
        loading={newsHeadlinesLoading}
        error={newsHeadlinesError}
        secondsPerHeadline={newsSecondsPerHeadline}
        onRefresh={() => { if (api) void refreshNewsHeadlines(api); }}
      />}
      {!isRenter && <StockTickerBar
        quotes={stockQuotes}
        loading={stockQuotesLoading}
        error={stockQuotesError}
        secondsPerSymbol={stockSecondsPerSymbol}
        onRefresh={() => { if (api) void refreshStockQuotes(api); }}
      />}

      <nav className={`mobile-nav ${canAccessScreen("properties") ? "has-properties" : ""} ${isRenter ? "renter-only" : ""}`} aria-label="Mobile navigation">
        {canUseMail && <button className={viewMode === "mail" && mobileView === "folders" ? "selected" : ""} onClick={() => {
          setMobileMenuOpen(false);
          navigateView("mail");
          setMobileView("folders");
        }}>
          <FolderOpen size={19} /><span>Folders</span>
        </button>}
        {canUseMail && <button className={viewMode === "mail" && mobileView !== "folders" ? "selected" : ""} onClick={() => {
          setMobileMenuOpen(false);
          navigateView("mail");
          if (selectedMessageId) closeMessage(); else setMobileView("messages");
        }}>
          <List size={19} /><span>Mail</span>
        </button>}
        {canAccessScreen("compose") && (
          <button className="mobile-compose-nav" onClick={() => openCompose()} disabled={readOnly}>
            <span className="mobile-compose-icon"><MailPlus size={21} /></span><span>Compose</span>
          </button>
        )}
        {canAccessScreen("calendar") && (
          <button className={viewMode === "calendar" ? "selected" : ""} onClick={() => {
            setMobileMenuOpen(false);
            navigateView("calendar");
          }}>
            <CalendarDays size={19} /><span>Calendar</span>
          </button>
        )}
        {canAccessScreen("properties") && (
          <button className={viewMode === "properties" ? "selected" : ""} onClick={() => {
            setMobileMenuOpen(false);
            navigateView("properties");
          }}>
            <Building2 size={19} /><span>Properties</span>
          </button>
        )}
        <button className={mobileMenuOpen ? "selected" : ""} onClick={() => setMobileMenuOpen((open) => !open)} aria-expanded={mobileMenuOpen}>
          <MoreHorizontal size={20} /><span>More</span>
          {(reviewQueue?.totalItems ?? 0) > 0 && <span className="mobile-nav-count">{Math.min(99, reviewQueue!.totalItems)}</span>}
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="mobile-action-backdrop" role="presentation" onMouseDown={() => setMobileMenuOpen(false)}>
          <section className="mobile-action-sheet" role="dialog" aria-modal="true" aria-label="More actions" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>{session.user.displayName}</strong>
                <span>{session.user.username} · {session.role}</span>
              </div>
              <button className="icon-button" onClick={() => setMobileMenuOpen(false)} aria-label="Close more actions"><X size={19} /></button>
            </header>
            <div className="mobile-action-grid">
              {!readOnly && canAccessScreen("compose") && <button onClick={() => { setMobileMenuOpen(false); openDrafts(); }}><FileEdit size={20} /><span>Drafts</span></button>}
              {canAccessScreen("ai") && <button onClick={() => { setMobileMenuOpen(false); openReviewQueue(); }}><BrainCircuit size={20} /><span>AI review</span>{(reviewQueue?.totalItems ?? 0) > 0 && <small>{reviewQueue!.totalItems}</small>}</button>}
              {canUseMail && <button onClick={() => { setMobileMenuOpen(false); openGmail(); }}><RefreshCw size={20} /><span>Gmail sync</span></button>}
              {!readOnly && canAccessScreen("import") && <button onClick={() => { setMobileMenuOpen(false); openImport(); }}><Import size={20} /><span>Import</span></button>}
              {!readOnly && (isAdmin || isRenter || canAccessScreen("settings")) && <button onClick={() => { setMobileMenuOpen(false); setSettingsOpen(true); }}><SettingsIcon size={20} /><span>{isAdmin ? "Admin" : "Account"}</span>{isAdmin && pendingDiagnosticCount > 0 && <small>{pendingDiagnosticCount}</small>}</button>}
              {isAdmin && <button onClick={() => { setMobileMenuOpen(false); void openSharing(); }}><MonitorSmartphone size={20} /><span>Phone access</span></button>}
            </div>
            <button className="mobile-sign-out" onClick={() => { setMobileMenuOpen(false); void logout(); }}><LogOut size={18} /> Sign out</button>
          </section>
        </div>
      )}

      <ImportDialog
        open={importOpen}
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
        initialParentId={createMailboxParentId}
        busy={createMailboxBusy}
        onClose={() => {
          setCreateMailboxOpen(false);
          setCreateMailboxParentId(null);
        }}
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
      <MailboxDropDialog
        source={mailboxDrop?.source ?? null}
        target={mailboxDrop?.target ?? null}
        busy={mailboxDropBusy}
        onClose={() => setMailboxDrop(null)}
        onMerge={() => void organizeDroppedMailbox("merge")}
        onMoveAsChild={() => void organizeDroppedMailbox("child")}
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
        onDelete={composeDraft?.id && !readOnly ? () => void deleteOpenDraft() : undefined}
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
      <AiReviewQueueDialog
        open={reviewQueueOpen}
        queue={reviewQueue}
        loading={reviewQueueLoading}
        busyItemId={reviewActionBusyId}
        reviewAllBusy={reviewAllBusy}
        planningAction={reviewPlanningAction}
        readOnly={readOnly}
        onClose={() => setReviewQueueOpen(false)}
        onRefresh={() => void refreshReviewQueue()}
        onOpenDraft={(draft) => {
          setReviewQueueOpen(false);
          openGeneratedDraft(draft);
        }}
        onDeleteDraft={(draft) => void deleteReviewDraft(draft)}
        onOpenMessage={(target) => {
          setReviewQueueOpen(false);
          void openMessage(target);
        }}
        onCreateAction={(item, action) => void createReviewAnalysisAction(item, action)}
        onMarkAnalysisReviewed={(item) => void markReviewAnalysisReviewed(item)}
        onMarkAllAnalysesReviewed={() => void markAllReviewAnalysesReviewed()}
        onCompleteFollowUp={(followUp) => void completeReviewFollowUp(followUp.id, followUp.messageId)}
      />
      {api && reviewActionDraft && (
        <MessageActionDialog
          key={`${reviewActionDraft.item.message.id}:${reviewActionDraft.initialAction}`}
          api={api}
          messageId={reviewActionDraft.item.message.id}
          suggestion={reviewActionDraft.suggestion}
          connections={gmailConnections}
          initialAction={reviewActionDraft.initialAction}
          onClose={() => setReviewActionDraft(null)}
          onCreated={async (notice, action) => {
            const target = reviewActionDraft.item;
            if (action === "calendar_event") {
              updateMessageIndicators(target.message.id, { hasCalendarEvent: true });
            }
            setReviewActionBusyId(target.message.id);
            let finalNotice = `${notice} The message was marked reviewed.`;
            try {
              await api.markMessageAnalysisReviewed(target.message.id);
              await refreshReviewQueue();
            } catch (error) {
              const reason = error instanceof Error ? error.message : "review status could not be updated";
              finalNotice = `${notice} The action was created, but the message was not marked reviewed: ${reason}`;
            } finally {
              setReviewActionBusyId(null);
              setReviewActionDraft(null);
              showError(finalNotice);
            }
          }}
          onError={showError}
        />
      )}
      <GuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />
      {!readOnly && (
        <SettingsDialog
          open={settingsOpen}
          api={api}
          session={session}
          onClose={() => setSettingsOpen(false)}
          onSignedOut={signOutLocally}
          onOpenGuide={() => {
            setSettingsOpen(false);
            setGuideOpen(true);
          }}
          onOpenDiagnostics={() => {
            setSettingsOpen(false);
            openDiagnostics();
          }}
          pendingDiagnosticCount={pendingDiagnosticCount}
          onAddGoogleCalendar={() => { setSettingsOpen(false); openGmail(); }}
          onReauthorizeGoogleCalendar={(connection) => { setSettingsOpen(false); reauthorizeGmail(connection); }}
          onStockSettingsChanged={() => { if (api) void refreshStockQuotes(api); }}
          onNewsSettingsChanged={() => { if (api) void refreshNewsHeadlines(api); }}
          onInboxTabSettingsChanged={(settings) => {
            if (settings.archiveId !== selectedArchiveId) return;
            setInboxTabSettings(settings);
            const nextCategory = settings.tabs.some((tab) => tab.id === inboxCategory && tab.enabled)
              ? inboxCategory
              : "primary";
            setInboxCategory(nextCategory);
            if (nextCategory === inboxCategory) void loadMessages(false);
          }}
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

function showGmailAuthorizationError(popup: Window, message: string) {
  popup.document.title = "Gmail authorization could not start";
  popup.document.body.replaceChildren();
  const main = popup.document.createElement("main");
  const heading = popup.document.createElement("h1");
  heading.textContent = "Gmail authorization could not start";
  const detail = popup.document.createElement("p");
  detail.textContent = message;
  const guidance = popup.document.createElement("p");
  guidance.textContent = "Return to Archive Mail, correct the Gmail OAuth configuration in Admin settings, and try again.";
  main.append(heading, detail, guidance);
  popup.document.body.append(main);
}

function hitToItem(hit: SearchHit): MessageListItem {
  return { message: hit.message, hit };
}

function messageToItem(message: MessageSummary): MessageListItem {
  return { message };
}
