import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent
} from "react";
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  CloudDownload,
  Database,
  Download,
  FileJson,
  ListFilter,
  KeyRound,
  LoaderCircle,
  MailCheck,
  Paperclip,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Save,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X
} from "lucide-react";
import type {
  AdminInsights,
  AdminSettings,
  AiAgentSkillId,
  AiModelOption,
  AiProviderId,
  AiSchedule,
  AiScheduleMode,
  AiScheduleRunProgress,
  AiScheduleTask,
  Archive as ArchiveModel,
  AuditEvent,
  AuthSessionInfo,
  DatabaseProvider,
  Folder,
  GmailConnection,
  MessageSummary,
  ResumeAsset,
  SenderFilingStatus,
  UserSummary
} from "@email-client/shared";
import { AI_AGENT_SKILLS, AI_AGENT_SKILL_IDS, AI_PROVIDER_IDS } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";

type SettingsSection = "database" | "gmail" | "sender-filing" | "ai" | "resumes" | "insights" | "users" | "security" | "audit";

const AI_PROVIDER_LABELS: Record<AiProviderId, string> = { openai: "OpenAI", deepseek: "DeepSeek" };
const AI_PROVIDER_ENV_VARS: Record<AiProviderId, string> = { openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY" };

interface SettingsDialogProps {
  open: boolean;
  api: ApiClient | null;
  session: AuthSessionInfo;
  onClose(): void;
  onSignedOut(): void;
}

const MENU: Array<{ id: SettingsSection; label: string; icon: typeof Database }> = [
  { id: "database", label: "Database", icon: Database },
  { id: "gmail", label: "Gmail", icon: MailCheck },
  { id: "sender-filing", label: "Sender rules", icon: ListFilter },
  { id: "ai", label: "AI", icon: BrainCircuit },
  { id: "resumes", label: "Resumes", icon: Paperclip },
  { id: "insights", label: "Insights", icon: BarChart3 },
  { id: "users", label: "Users", icon: Users },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "audit", label: "Audit", icon: ScrollText }
];

export function SettingsDialog({
  open,
  api,
  session,
  onClose,
  onSignedOut
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>("database");
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadAdminData = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      const [nextSettings, nextUsers] = await Promise.all([
        api.adminSettings(),
        api.listUsers()
      ]);
      setSettings(nextSettings);
      setUsers(nextUsers);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) void loadAdminData();
  }, [open, loadAdminData]);

  if (!open) return null;

  const showNotice = (message: string) => {
    setNotice(message);
    setError("");
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><Settings size={20} /><h2 id="settings-title">Admin settings</h2></div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-menu" aria-label="Settings panels">
            {MENU.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={section === item.id ? "selected" : ""} onClick={() => { setSection(item.id); setError(""); setNotice(""); }}>
                  <Icon size={17} /><span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <article className="settings-content">
            {loading && !settings ? <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading settings</div> : (
              <>
                {section === "database" && settings && (
                  <DatabasePanel
                    api={api!}
                    settings={settings}
                    busy={busy}
                    onBusy={setBusy}
                    onSettings={setSettings}
                    onError={setError}
                    onNotice={showNotice}
                  />
                )}
                {section === "gmail" && settings && (
                  <GmailPanel
                    api={api!}
                    settings={settings}
                    busy={busy}
                    onBusy={setBusy}
                    onSettings={setSettings}
                    onError={setError}
                    onNotice={showNotice}
                  />
                )}
                {section === "sender-filing" && (
                  <SenderFilingPanel
                    api={api!}
                    busy={busy}
                    onBusy={setBusy}
                    onError={setError}
                    onNotice={showNotice}
                  />
                )}
                {section === "ai" && settings && (
                  <AiPanel
                    api={api!}
                    settings={settings}
                    busy={busy}
                    onBusy={setBusy}
                    onSettings={setSettings}
                    onError={setError}
                    onNotice={showNotice}
                  />
                )}
                {section === "resumes" && (
                  <ResumePanel api={api!} busy={busy} onBusy={setBusy} onError={setError} onNotice={showNotice} />
                )}
                {section === "insights" && <InsightsPanel api={api!} onError={setError} />}
                {section === "users" && (
                  <UsersPanel
                    api={api!}
                    users={users}
                    currentUserId={session.user.id}
                    busy={busy}
                    onBusy={setBusy}
                    onUsers={setUsers}
                    onError={setError}
                    onNotice={showNotice}
                  />
                )}
                {section === "security" && settings && (
                  <SecurityPanel
                    api={api!}
                    settings={settings}
                    busy={busy}
                    onBusy={setBusy}
                    onError={setError}
                    onSignedOut={onSignedOut}
                  />
                )}
                {section === "audit" && <AuditPanel api={api!} onError={setError} />}
              </>
            )}
            {error && <p className="settings-message error" role="alert">{error}</p>}
            {notice && <p className="settings-message success" role="status"><CheckCircle2 size={15} />{notice}</p>}
          </article>
        </div>
      </section>
    </div>
  );
}

function SenderFilingPanel({
  api,
  busy,
  onBusy,
  onError,
  onNotice
}: {
  api: ApiClient;
  busy: boolean;
  onBusy(value: boolean): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [archives, setArchives] = useState<ArchiveModel[]>([]);
  const [archiveId, setArchiveId] = useState("");
  const [status, setStatus] = useState<SenderFilingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listArchives().then((items) => {
      if (!active) return;
      const available = items.filter((archive) => ["ready", "ready_with_errors"].includes(archive.status));
      setArchives(available);
      setArchiveId((current) => available.some((archive) => archive.id === current) ? current : available[0]?.id ?? "");
    }).catch((loadError) => {
      if (active) onError(errorText(loadError));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, onError]);

  const loadStatus = useCallback(async (selectedArchiveId: string) => {
    if (!selectedArchiveId) {
      setStatus(null);
      return;
    }
    setLoading(true);
    onError("");
    try {
      setStatus(await api.senderFilingStatus(selectedArchiveId));
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => { void loadStatus(archiveId); }, [archiveId, loadStatus]);

  const organize = async () => {
    if (!archiveId) return;
    if (!window.confirm("Create folders for this archive's top 20 Inbox senders and move their current Inbox messages?")) return;
    onBusy(true);
    onError("");
    try {
      const nextStatus = await api.organizeTopSenders(archiveId);
      setStatus(nextStatus);
      onNotice(`Sender rules active for ${nextStatus.rules.length} sender${nextStatus.rules.length === 1 ? "" : "s"}. Moved ${nextStatus.lastRunMovedMessages} message${nextStatus.lastRunMovedMessages === 1 ? "" : "s"}.`);
    } catch (organizeError) {
      onError(errorText(organizeError));
    } finally {
      onBusy(false);
    }
  };

  const disable = async () => {
    if (!archiveId || !status?.enabled) return;
    if (!window.confirm("Disable automatic sender filing? Existing folders and filed messages will remain where they are.")) return;
    onBusy(true);
    onError("");
    try {
      setStatus(await api.disableSenderFiling(archiveId));
      onNotice("Automatic sender filing disabled. Existing folders and messages were kept.");
    } catch (disableError) {
      onError(errorText(disableError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>Sender rules</h3>
      <p>Create up to 20 local folders for the most frequent senders currently in an archive's Inbox. Matching messages are moved immediately, and future imported Inbox mail from those addresses is filed automatically.</p>
      <div className="settings-warning neutral"><ShieldCheck size={17} /><span>All other Inbox mail stays in Inbox. Spam and every non-Inbox mailbox are untouched. These local rules do not change Gmail labels.</span></div>
      <div className="settings-form">
        <label>Archive
          <select value={archiveId} onChange={(event) => setArchiveId(event.target.value)} disabled={busy || loading || archives.length === 0}>
            {archives.length === 0 && <option value="">No ready archives</option>}
            {archives.map((archive) => <option key={archive.id} value={archive.id}>{archive.name} · {archive.messageCount.toLocaleString()} messages</option>)}
          </select>
        </label>
        <div className="settings-button-row">
          <button type="button" className="primary-button compact" disabled={busy || loading || !archiveId} onClick={() => void organize()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ListFilter size={16} />} Organize top 20
          </button>
          {status?.enabled && (
            <button type="button" className="danger-button" disabled={busy} onClick={() => void disable()}><Power size={16} /> Disable rules</button>
          )}
          <button type="button" className="secondary-button" disabled={busy || loading || !archiveId} onClick={() => void loadStatus(archiveId)}>
            {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Refresh status
          </button>
        </div>
        {status?.lastRunAt && (
          <small>Last run {formatDate(status.lastRunAt)} · moved {status.lastRunMovedMessages.toLocaleString()} · created {status.lastRunCreatedFolders.toLocaleString()} folders</small>
        )}
      </div>
      {loading && !status ? (
        <div className="settings-loading"><LoaderCircle className="spin" size={18} /> Loading sender rules</div>
      ) : status?.rules.length ? (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead><tr><th>Sender</th><th>Filed messages</th><th>Folder</th></tr></thead>
            <tbody>
              {status.rules.map((rule) => (
                <tr key={rule.id}>
                  <td><strong>{rule.senderName || rule.senderAddress}</strong>{rule.senderName && <small>{rule.senderAddress}</small>}</td>
                  <td>{rule.messageCount.toLocaleString()}</td>
                  <td>
                    <strong>{rule.folderPath}</strong>
                    {rule.ruleType === "spam" && <small>Always spam</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="settings-empty">No automatic sender rules are active for this archive.</p>
      )}
    </>
  );
}

function DatabasePanel({
  api,
  settings,
  busy,
  onBusy,
  onSettings,
  onError,
  onNotice
}: {
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onSettings(value: AdminSettings): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [provider, setProvider] = useState<DatabaseProvider>(settings.database.configuredProvider);
  const [connectionString, setConnectionString] = useState(settings.database.configuredConnectionString);
  const option = settings.database.providers.find((item) => item.id === provider);

  useEffect(() => {
    setProvider(settings.database.configuredProvider);
    setConnectionString(settings.database.configuredConnectionString);
  }, [settings]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      onSettings(await api.updateDatabaseSettings({ provider, connectionString }));
      onNotice("Database configuration saved. Restart Archive Mail to activate a changed connection.");
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>Database</h3>
      <p>Structured mail, state, jobs, users, sessions, audit records, and search indexes use the active database adapter.</p>
      {settings.database.restartRequired && (
        <div className="settings-warning"><AlertTriangle size={17} /><span>A saved database change is waiting for an application restart.</span></div>
      )}
      <form className="settings-form" onSubmit={save}>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value as DatabaseProvider)} disabled={busy}>
            {settings.database.providers.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " (adapter not installed)"}</option>
            ))}
          </select>
        </label>
        <label>
          Connection string
          <input value={connectionString} onChange={(event) => setConnectionString(event.target.value)} spellCheck={false} disabled={busy} />
        </label>
        {option && <small>{option.description}</small>}
        <button className="primary-button" disabled={busy || !option?.available || !connectionString.trim()}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save database setting
        </button>
      </form>
      <dl className="settings-definitions">
        <div><dt>Active adapter</dt><dd>{settings.database.activeProvider}</dd></div>
        <div><dt>Active connection</dt><dd><code>{settings.database.activeConnectionString}</code></dd></div>
        <div><dt>Structured data</dt><dd><code>{settings.database.structuredDataPath}</code></dd></div>
        <div><dt>Attachment bytes</dt><dd><code>{settings.database.attachmentBlobPath}</code></dd></div>
      </dl>
      <div className="settings-warning neutral"><Database size={17} /><span>Changing the connection does not migrate existing data. Attachment bytes remain in the content-addressed blob directory.</span></div>
    </>
  );
}

function GmailPanel({
  api,
  settings,
  busy,
  onBusy,
  onSettings,
  onError,
  onNotice
}: {
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onSettings(value: AdminSettings): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [clientId, setClientId] = useState(settings.gmail.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(settings.gmail.syncIntervalMinutes);
  const [loadedFilename, setLoadedFilename] = useState("");
  const [connections, setConnections] = useState<GmailConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const environmentManaged = settings.gmail.source === "environment";
  const intervalEnvManaged = settings.gmail.syncIntervalEnvManaged;

  useEffect(() => {
    setClientId(settings.gmail.clientId);
    setClientSecret("");
    setClearClientSecret(false);
    setSyncIntervalMinutes(settings.gmail.syncIntervalMinutes);
  }, [settings.gmail]);

  const refreshConnections = useCallback(async (showLoading = false) => {
    if (showLoading) setConnectionsLoading(true);
    try {
      setConnections(await api.listGmailConnections());
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      if (showLoading) setConnectionsLoading(false);
    }
  }, [api, onError]);

  useEffect(() => { void refreshConnections(true); }, [refreshConnections]);

  useEffect(() => {
    if (!connections.some((connection) => connection.status === "syncing")) return;
    const interval = window.setInterval(() => void refreshConnections(), 1_500);
    return () => window.clearInterval(interval);
  }, [connections, refreshConnections]);

  const loadJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    onError("");
    try {
      const credentials = parseDesktopOAuthJson(await file.text());
      setClientId(credentials.clientId);
      setClientSecret(credentials.clientSecret);
      setClearClientSecret(false);
      setLoadedFilename(file.name);
      onNotice(`${file.name} loaded. Save the Gmail configuration to activate it.`);
    } catch (loadError) {
      setLoadedFilename("");
      onError(errorText(loadError));
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateGmailSettings({
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        clearClientSecret,
        syncIntervalMinutes
      });
      onSettings(updated);
      setClientSecret("");
      setClearClientSecret(false);
      setLoadedFilename("");
      onNotice("Gmail OAuth configuration saved and activated.");
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      onBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("Clear the saved Gmail OAuth configuration? Existing Gmail connections will no longer refresh until configuration is restored.")) return;
    onBusy(true);
    onError("");
    try {
      onSettings(await api.clearGmailSettings());
      setLoadedFilename("");
      onNotice("Gmail OAuth configuration cleared.");
    } catch (clearError) {
      onError(errorText(clearError));
    } finally {
      onBusy(false);
    }
  };

  const pullAll = async (connection: GmailConnection) => {
    if (!window.confirm(
      `Pull the complete Gmail history for ${connection.email}, including Spam and Trash? `
      + "This removes the original date filter for future syncs and can take a long time for large accounts."
    )) return;
    setPullingId(connection.id);
    onError("");
    try {
      const updated = await api.syncGmail(connection.id, { full: true });
      setConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      onNotice(`Full-history Gmail pull started for ${connection.email}.`);
    } catch (pullError) {
      onError(errorText(pullError));
    } finally {
      setPullingId(null);
    }
  };

  const stopPull = async (connection: GmailConnection) => {
    setPullingId(connection.id);
    onError("");
    try {
      const updated = await api.cancelGmailSync(connection.id);
      setConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
      onNotice(`Gmail pull stopped for ${connection.email}.`);
    } catch (cancelError) {
      onError(errorText(cancelError));
    } finally {
      setPullingId(null);
    }
  };

  return (
    <>
      <h3>Gmail</h3>
      <p>One Google Desktop OAuth configuration can authorize multiple Gmail accounts. Each account keeps a separate token and sync status; Gmail passwords are never stored.</p>
      {settings.gmail.configurationError && (
        <div className="settings-warning"><AlertTriangle size={17} /><span>{settings.gmail.configurationError}</span></div>
      )}
      <div className={`settings-warning ${settings.gmail.configured ? "configured" : ""}`}>
        {settings.gmail.configured ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <span>{settings.gmail.configured
          ? `OAuth client configured${settings.gmail.clientSecretConfigured ? " with a client secret" : ""}.`
          : "OAuth client not configured. Gmail authorization cannot start."}</span>
      </div>
      {environmentManaged && (
        <div className="settings-warning neutral"><ShieldCheck size={17} /><span>This configuration comes from GMAIL_CLIENT_ID environment settings and cannot be changed in the admin panel.</span></div>
      )}
      <form className="settings-form gmail-settings-form" onSubmit={(event) => void save(event)}>
        <label className="gmail-json-picker">
          Desktop OAuth JSON
          <span className="gmail-file-control"><FileJson size={17} /><span>{loadedFilename || "Choose downloaded JSON"}</span></span>
          <input type="file" accept="application/json,.json" onChange={(event) => void loadJson(event)} disabled={busy || environmentManaged} />
        </label>
        <small>The file must contain Google’s <code>installed.client_id</code> value. Its client secret is stored locally and is never returned by the API.</small>
        <label>
          Client ID
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy || environmentManaged} placeholder="Desktop OAuth client ID" />
        </label>
        <label>
          Client secret {settings.gmail.clientSecretConfigured ? "(saved)" : "(optional)"}
          <input type="password" value={clientSecret} onChange={(event) => { setClientSecret(event.target.value); setClearClientSecret(false); }} spellCheck={false} autoComplete="new-password" disabled={busy || environmentManaged || clearClientSecret} placeholder={settings.gmail.clientSecretConfigured ? "Leave blank to keep the saved secret" : "Desktop OAuth client secret"} />
        </label>
        {settings.gmail.clientSecretConfigured && !environmentManaged && (
          <label className="settings-checkbox">
            <input type="checkbox" checked={clearClientSecret} onChange={(event) => { setClearClientSecret(event.target.checked); if (event.target.checked) setClientSecret(""); }} disabled={busy} />
            <span>Remove the saved client secret</span>
          </label>
        )}
        <label>
          Auto-sync every
          <select
            value={syncIntervalMinutes}
            onChange={(event) => setSyncIntervalMinutes(Number(event.target.value))}
            disabled={busy || intervalEnvManaged}
          >
            <option value={0}>Off (manual sync only)</option>
            <option value={2}>2 minutes</option>
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
        <small>Each connected Gmail account is pulled automatically on this interval, in addition to the manual sync button. Set to Off to sync only on command.</small>
        {intervalEnvManaged && (
          <div className="settings-warning neutral"><ShieldCheck size={17} /><span>The sync interval comes from GMAIL_SYNC_INTERVAL_MINUTES environment settings and cannot be changed here.</span></div>
        )}
        <div className="settings-button-row">
          <button className="primary-button" disabled={busy || environmentManaged || !clientId.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save Gmail configuration
          </button>
          {settings.gmail.source === "admin" && (
            <button type="button" className="danger-button" disabled={busy} onClick={() => void clear()}><Trash2 size={16} /> Clear configuration</button>
          )}
        </div>
      </form>
      <dl className="settings-definitions">
        <div><dt>Status</dt><dd>{settings.gmail.configured ? "Configured" : "Not configured"}</dd></div>
        <div><dt>Source</dt><dd>{settings.gmail.source === "admin" ? "Admin settings" : settings.gmail.source === "environment" ? "Environment" : "None"}</dd></div>
        <div><dt>Settings file</dt><dd><code>{settings.gmail.settingsPath}</code></dd></div>
      </dl>
      <section className="admin-gmail-sync">
        <div className="settings-title-row">
          <div>
            <h3>Connected account pulls</h3>
            <p>Pull every message from Gmail, across the full account history. Progress continues if you close this window.</p>
          </div>
          <button type="button" className="secondary-button" disabled={connectionsLoading} onClick={() => void refreshConnections(true)}>
            <RefreshCw size={16} className={connectionsLoading ? "spin" : ""} /> Refresh
          </button>
        </div>
        {connectionsLoading ? (
          <div className="settings-loading"><LoaderCircle className="spin" size={18} /> Loading Gmail accounts</div>
        ) : connections.length === 0 ? (
          <p className="settings-hint">No Gmail accounts are connected yet. Use the Gmail button in the main toolbar to authorize one.</p>
        ) : (
          <div className="admin-gmail-connections">
            {connections.map((connection) => {
              const percent = connection.totalItems && connection.totalItems > 0
                ? Math.min(100, Math.round(connection.processedItems / connection.totalItems * 100))
                : 0;
              const acting = pullingId === connection.id;
              return (
                <article className="admin-gmail-connection" key={connection.id}>
                  <div className="admin-gmail-copy">
                    <strong>{connection.email}</strong>
                    <span>{connection.archiveName} / {connection.folderPath}</span>
                    {connection.status === "syncing" ? (
                      <>
                        <progress max={100} value={percent} />
                        <small>
                          {connection.processedItems.toLocaleString()} of {(connection.totalItems ?? 0).toLocaleString()} checked
                          {` · ${connection.importedItems.toLocaleString()} new · ${percent}%`}
                        </small>
                      </>
                    ) : (
                      <small className={connection.status === "error" ? "error" : ""}>
                        {connection.lastError
                          ?? (connection.lastSyncedAt ? `Last completed ${formatDate(connection.lastSyncedAt)}` : "Never pulled")}
                      </small>
                    )}
                  </div>
                  {connection.status === "syncing" ? (
                    <button type="button" className="danger-button" disabled={acting} onClick={() => void stopPull(connection)}>
                      {acting ? <LoaderCircle className="spin" size={16} /> : <X size={16} />} Stop
                    </button>
                  ) : (
                    <button type="button" className="primary-button compact" disabled={acting} onClick={() => void pullAll(connection)}>
                      {acting ? <LoaderCircle className="spin" size={16} /> : <CloudDownload size={16} />} Pull all email
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <div className="settings-warning neutral"><MailCheck size={17} /><span>Changing the OAuth client may require existing Gmail accounts to be disconnected and authorized again.</span></div>
    </>
  );
}

function InsightsPanel({ api, onError }: { api: ApiClient; onError(value: string): void }) {
  const [insights, setInsights] = useState<AdminInsights | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      setInsights(await api.adminInsights());
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !insights) {
    return <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading insights</div>;
  }
  if (!insights) return null;

  return (
    <>
      <div className="settings-title-row">
        <div>
          <h3>Insights</h3>
          <p>A snapshot of everything imported and analyzed so far, generated {formatDate(insights.generatedAt)}.</p>
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={16} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      <dl className="settings-definitions">
        <div><dt>Total messages</dt><dd>{insights.totalMessages.toLocaleString()}</dd></div>
        <div><dt>Total attachments</dt><dd>{insights.totalAttachments.toLocaleString()}</dd></div>
        <div>
          <dt>Oldest message</dt>
          <dd>{insights.endpoints.oldest
            ? `${formatDate(insights.endpoints.oldest.date)} — "${insights.endpoints.oldest.subject}" from ${insights.endpoints.oldest.senderName || insights.endpoints.oldest.senderAddress}`
            : "None yet"}</dd>
        </div>
        <div>
          <dt>Newest message</dt>
          <dd>{insights.endpoints.newest
            ? `${formatDate(insights.endpoints.newest.date)} — "${insights.endpoints.newest.subject}" from ${insights.endpoints.newest.senderName || insights.endpoints.newest.senderAddress}`
            : "None yet"}</dd>
        </div>
      </dl>

      <div className="insights-columns">
        <section className="insights-card">
          <h4>Top 10 senders</h4>
          {insights.topSenders.length === 0 ? <p className="settings-hint">No data yet.</p> : (
            <ol className="insights-contact-list">
              {insights.topSenders.map((contact) => (
                <li key={contact.address}>
                  <span className="insights-contact-name">{contact.name || contact.address}</span>
                  <span className="insights-contact-count">{contact.count.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="insights-card">
          <h4>Top 10 recipients</h4>
          {insights.topRecipients.length === 0 ? <p className="settings-hint">No data yet.</p> : (
            <ol className="insights-contact-list">
              {insights.topRecipients.map((contact) => (
                <li key={contact.address}>
                  <span className="insights-contact-name">{contact.name || contact.address}</span>
                  <span className="insights-contact-count">{contact.count.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="insights-card">
        <h4>AI analysis summary</h4>
        {!insights.analysis ? (
          <p className="settings-hint">No messages have been analyzed yet — use Analyze on a message, or set up a scheduled sweep on the AI tab.</p>
        ) : (
          <>
            <dl className="settings-definitions">
              <div><dt>Analyzed</dt><dd>{insights.analysis.analyzedCount.toLocaleString()} messages</dd></div>
              <div><dt>Action required</dt><dd>{insights.analysis.actionRequiredCount.toLocaleString()}</dd></div>
              <div><dt>Draft recommended</dt><dd>{insights.analysis.draftRecommendedCount.toLocaleString()}</dd></div>
              <div><dt>Flagged spam</dt><dd>{insights.analysis.flaggedSpamCount.toLocaleString()} (avg probability {(insights.analysis.averageSpamProbability * 100).toFixed(0)}%)</dd></div>
              <div><dt>Flagged phishing</dt><dd>{insights.analysis.flaggedPhishingCount.toLocaleString()} (avg probability {(insights.analysis.averagePhishingProbability * 100).toFixed(0)}%)</dd></div>
              <div>
                <dt>Priority breakdown</dt>
                <dd>
                  {(["urgent", "high", "normal", "low"] as const)
                    .map((priority) => `${priority}: ${insights.analysis!.priorityBreakdown[priority].toLocaleString()}`)
                    .join(" · ")}
                </dd>
              </div>
            </dl>
            {insights.analysis.topCategories.length > 0 && (
              <>
                <h4>Top categories</h4>
                <ol className="insights-contact-list">
                  {insights.analysis.topCategories.map((entry) => (
                    <li key={entry.category}>
                      <span className="insights-contact-name">{entry.category}</span>
                      <span className="insights-contact-count">{entry.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}

function AiPanel({
  api,
  settings,
  busy,
  onBusy,
  onSettings,
  onError,
  onNotice
}: {
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onSettings(value: AdminSettings): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [enabled, setEnabled] = useState(settings.ai.enabled);
  const [dailyLimit, setDailyLimit] = useState(settings.ai.dailyRequestLimit);
  const [monthlyLimit, setMonthlyLimit] = useState(settings.ai.monthlyRequestLimit);
  const activeProvider = settings.ai.activeProvider;
  const activeInfo = settings.ai.providers[activeProvider];
  const activeLabel = AI_PROVIDER_LABELS[activeProvider];

  useEffect(() => {
    setEnabled(settings.ai.enabled);
    setDailyLimit(settings.ai.dailyRequestLimit);
    setMonthlyLimit(settings.ai.monthlyRequestLimit);
  }, [settings.ai.enabled, settings.ai.dailyRequestLimit, settings.ai.monthlyRequestLimit]);

  const saveGlobal = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateAiSettings({
        clearApiKey: false,
        enabled,
        dailyRequestLimit: dailyLimit,
        monthlyRequestLimit: monthlyLimit
      });
      onSettings(updated);
      onNotice("AI configuration saved.");
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>AI</h3>
      <p>
        Email analysis uses an OpenAI or DeepSeek API project key. A ChatGPT or DeepSeek chat subscription does
        not provide API billing or an API key. Connect one or both providers below — whichever card is marked
        Active is the one used when you click Analyze on a message.
      </p>
      {settings.ai.configurationError && (
        <div className="settings-warning"><AlertTriangle size={17} /><span>{settings.ai.configurationError}</span></div>
      )}
      <div className={`settings-warning ${activeInfo.configured && settings.ai.enabled ? "configured" : ""}`}>
        {activeInfo.configured && settings.ai.enabled ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <span>{!activeInfo.configured
          ? `${activeLabel} (active provider) API key not configured.`
          : settings.ai.enabled
            ? `AI analysis enabled with ${activeLabel} (${activeInfo.model}).`
            : `${activeLabel} API key configured, but AI analysis is disabled.`}</span>
      </div>
      <div className="settings-warning neutral"><ShieldCheck size={17} /><span>Analyzed email text is sent to whichever provider is active. API keys and email bodies are excluded from diagnostics and audit records.</span></div>

      <form className="settings-form" onSubmit={(event) => void saveGlobal(event)}>
        <label className="settings-checkbox settings-toggle-row">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />
          <span>Enable AI analysis</span>
        </label>
        <div className="settings-form-grid ai-limit-grid">
          <label>
            Daily request limit
            <input type="number" min={1} max={100000} value={dailyLimit} onChange={(event) => setDailyLimit(Number(event.target.value))} disabled={busy} />
          </label>
          <label>
            Monthly request limit
            <input type="number" min={1} max={1000000} value={monthlyLimit} onChange={(event) => setMonthlyLimit(Number(event.target.value))} disabled={busy} />
          </label>
        </div>
        <div className="settings-button-row">
          <button className="primary-button compact" disabled={busy || dailyLimit < 1 || monthlyLimit < 1}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
          </button>
        </div>
      </form>

      <div className="ai-provider-cards">
        {AI_PROVIDER_IDS.map((provider) => (
          <AiProviderCard
            key={provider}
            provider={provider}
            api={api}
            settings={settings}
            busy={busy}
            onBusy={onBusy}
            onSettings={onSettings}
            onError={onError}
            onNotice={onNotice}
          />
        ))}
      </div>

      <dl className="settings-definitions">
        <div><dt>Today</dt><dd>{settings.ai.usage.todayRequests.toLocaleString()} requests · {(settings.ai.usage.todayInputTokens + settings.ai.usage.todayOutputTokens).toLocaleString()} tokens</dd></div>
        <div><dt>This month</dt><dd>{settings.ai.usage.monthRequests.toLocaleString()} requests · {(settings.ai.usage.monthInputTokens + settings.ai.usage.monthOutputTokens).toLocaleString()} tokens</dd></div>
        <div><dt>Settings file</dt><dd><code>{settings.ai.settingsPath}</code></dd></div>
      </dl>

      <AiSchedulesSection api={api} settings={settings} busy={busy} onBusy={onBusy} onError={onError} onNotice={onNotice} />
    </>
  );
}

function AiProviderCard({
  provider,
  api,
  settings,
  busy,
  onBusy,
  onSettings,
  onError,
  onNotice
}: {
  provider: AiProviderId;
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onSettings(value: AdminSettings): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const info = settings.ai.providers[provider];
  const isActive = settings.ai.activeProvider === provider;
  const usingEnvironment = info.source === "environment";
  const label = AI_PROVIDER_LABELS[provider];
  const supportsModelPicker = provider === "deepseek";

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(info.model);
  const [models, setModels] = useState<AiModelOption[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    setApiKey("");
    setModel(info.model);
    setModels(null);
  }, [info.model, provider]);

  const loadModels = async () => {
    setModelsLoading(true);
    onError("");
    try {
      setModels(await api.listAiModels(provider));
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setModelsLoading(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateAiSettings({
        provider,
        clearApiKey: false,
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      });
      onSettings(updated);
      setApiKey("");
      onNotice(`${label} configuration saved.`);
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      onBusy(false);
    }
  };

  const makeActive = async () => {
    onBusy(true);
    onError("");
    try {
      onSettings(await api.setActiveAiProvider(provider));
      onNotice(`${label} is now the active provider for Analyze.`);
    } catch (activeError) {
      onError(errorText(activeError));
    } finally {
      onBusy(false);
    }
  };

  const test = async () => {
    onBusy(true);
    onError("");
    try {
      await api.testAiConnection(provider);
      onNotice(`${label} connection succeeded for ${info.model}.`);
    } catch (testError) {
      onError(errorText(testError));
    } finally {
      onBusy(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm(`Remove the saved ${label} API key?`)) return;
    onBusy(true);
    onError("");
    try {
      onSettings(await api.clearAiApiKey(provider));
      onNotice(`Saved ${label} API key removed.`);
    } catch (clearError) {
      onError(errorText(clearError));
    } finally {
      onBusy(false);
    }
  };

  const modelOptions: AiModelOption[] = models
    ? (models.some((entry) => entry.id === model) ? models : [{ id: model, label: model, description: null, pricing: null }, ...models])
    : [{ id: model, label: model, description: null, pricing: null }];
  const selectedOption = modelOptions.find((entry) => entry.id === model) ?? null;

  return (
    <section className={`ai-provider-card ${isActive ? "active" : ""}`}>
      <header className="ai-provider-card-header">
        <h4>{label} {isActive && <span className="ai-active-badge">Active</span>}</h4>
        {!isActive && (
          <button type="button" className="text-button" disabled={busy} onClick={() => void makeActive()}>Make active</button>
        )}
      </header>
      {info.environmentApiKeyConfigured && (
        <div className="settings-warning neutral"><KeyRound size={15} /><span>{usingEnvironment
          ? `The current key comes from ${AI_PROVIDER_ENV_VARS[provider]}. Saving a key here overrides it; removing the saved key restores the environment value.`
          : `A saved Admin key overrides ${AI_PROVIDER_ENV_VARS[provider]}. Removing the saved key restores the environment value.`}</span></div>
      )}
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <label>
          {label} API key {info.savedApiKeyConfigured ? "(saved in Admin)" : usingEnvironment ? "(using environment)" : ""}
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            placeholder={info.apiKeyConfigured ? "Leave blank to keep the current key" : "sk-..."}
          />
        </label>
        {supportsModelPicker ? (
          <label>
            Model
            <div className="ai-model-picker">
              <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
                {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <button
                type="button"
                className="icon-button"
                disabled={busy || modelsLoading || !info.apiKeyConfigured}
                title={info.apiKeyConfigured ? "Load DeepSeek's current available models" : "Save an API key first"}
                aria-label={`Load ${label} models`}
                onClick={() => void loadModels()}
              >
                {modelsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              </button>
            </div>
            {!info.apiKeyConfigured && <small className="settings-hint">Save an API key first, then load the live model list.</small>}
            {selectedOption?.pricing && (
              <small className="settings-hint">
                {selectedOption.description ? `${selectedOption.description} ` : ""}{selectedOption.pricing}
              </small>
            )}
          </label>
        ) : (
          <label>
            Model
            <input value={model} onChange={(event) => setModel(event.target.value)} disabled={busy} spellCheck={false} />
          </label>
        )}
        <div className="settings-button-row">
          <button className="primary-button compact" disabled={busy || !model.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
          </button>
          <button type="button" className="secondary-button" disabled={busy || !info.configured} onClick={() => void test()}>
            <Sparkles size={16} /> Test
          </button>
          {info.savedApiKeyConfigured && (
            <button type="button" className="danger-button" disabled={busy} onClick={() => void clearKey()}><Trash2 size={16} /> Remove key</button>
          )}
        </div>
      </form>
    </section>
  );
}

function ResumePanel({
  api,
  busy,
  onBusy,
  onError,
  onNotice
}: {
  api: ApiClient;
  busy: boolean;
  onBusy(value: boolean): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [resumes, setResumes] = useState<ResumeAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResumes(await api.listResumes());
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    onBusy(true);
    onError("");
    try {
      const uploaded = await api.uploadResume(file, name);
      setResumes((current) => [uploaded, ...current]);
      setFile(null);
      setName("");
      onNotice(`Resume "${uploaded.name}" uploaded.`);
    } catch (uploadError) {
      onError(errorText(uploadError));
    } finally {
      onBusy(false);
    }
  };

  const remove = async (resume: ResumeAsset) => {
    if (!window.confirm(`Delete the resume "${resume.name}"? Existing drafts will keep working without the attachment.`)) return;
    onBusy(true);
    onError("");
    try {
      await api.deleteResume(resume.id);
      setResumes((current) => current.filter((entry) => entry.id !== resume.id));
      onNotice(`Resume "${resume.name}" removed.`);
    } catch (deleteError) {
      onError(errorText(deleteError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>Resumes</h3>
      <p>Upload one or more resumes for AI draft schedules. A selected resume is attached only when the AI classifies an email as a development opportunity, and the resulting draft still requires review before sending.</p>
      <div className="settings-warning neutral"><ShieldCheck size={17} /><span>Schedules never send resumes automatically. Open Drafts, review the email and attachment, then click Send.</span></div>
      <form className="settings-form" onSubmit={(event) => void upload(event)}>
        <div className="settings-form-grid">
          <label>Display name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Software engineering resume" disabled={busy} />
          </label>
          <label>Resume file
            <input
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              disabled={busy}
            />
            <small className="settings-hint">PDF, DOC, or DOCX · 5 MB maximum</small>
          </label>
        </div>
        <div className="settings-button-row">
          <button className="primary-button compact" disabled={busy || !file}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <CloudDownload size={16} />} Upload resume
          </button>
        </div>
      </form>
      {loading ? (
        <div className="settings-loading"><LoaderCircle className="spin" size={18} /> Loading resumes</div>
      ) : resumes.length === 0 ? (
        <p className="settings-empty">No resumes uploaded yet.</p>
      ) : (
        <ul className="resume-list">
          {resumes.map((resume) => (
            <li key={resume.id}>
              <Paperclip size={17} />
              <div><strong>{resume.name}</strong><span>{resume.filename} · {formatBytes(resume.sizeBytes)}</span></div>
              <button type="button" className="icon-button" disabled={busy} onClick={() => void api.downloadResume(resume)} title="Download resume" aria-label={`Download ${resume.name}`}><Download size={15} /></button>
              <button type="button" className="icon-button" disabled={busy} onClick={() => void remove(resume)} title="Delete resume" aria-label={`Delete ${resume.name}`}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AiSchedulesSection({
  api,
  settings,
  busy,
  onBusy,
  onError,
  onNotice
}: {
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [schedules, setSchedules] = useState<AiSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<AiSchedule | null>(null);
  const [archives, setArchives] = useState<ArchiveModel[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [archiveId, setArchiveId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [messageId, setMessageId] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [messageSearchBusy, setMessageSearchBusy] = useState(false);
  const [connections, setConnections] = useState<GmailConnection[]>([]);
  const [resumes, setResumes] = useState<ResumeAsset[]>([]);
  const [task, setTask] = useState<AiScheduleTask>("analyze");
  const [gmailConnectionId, setGmailConnectionId] = useState("");
  const [resumeId, setResumeId] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AiScheduleMode>("unread");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [provider, setProvider] = useState<AiProviderId>(settings.ai.activeProvider);
  const [model, setModel] = useState(settings.ai.providers[settings.ai.activeProvider].model);
  const [skills, setSkills] = useState<AiAgentSkillId[]>([...AI_AGENT_SKILL_IDS]);
  const [prompt, setPrompt] = useState("");
  const hasActiveRun = schedules.some((schedule) => schedule.progress
    && ["queueing", "processing"].includes(schedule.progress.status));

  const load = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      const [loadedSchedules, loadedConnections, loadedResumes] = await Promise.all([
        api.listAiSchedules(),
        api.listGmailConnections(),
        api.listResumes()
      ]);
      setSchedules(loadedSchedules);
      setConnections(loadedConnections.filter((connection) => connection.canSend));
      setResumes(loadedResumes);
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const loaded = await api.listAiSchedules();
        if (active) setSchedules(loaded);
      } catch {
        // The main request path handles visible errors and expired sessions.
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, hasActiveRun ? 2_000 : 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, hasActiveRun]);

  const changeArchive = async (nextArchiveId: string) => {
    setArchiveId(nextArchiveId);
    setFolderId("");
    setMessageId("");
    setMessageSearch("");
    setMessages([]);
    if (!nextArchiveId) {
      setFolders([]);
      return;
    }
    try {
      setFolders(await api.listFolders(nextArchiveId));
    } catch (loadError) {
      onError(errorText(loadError));
    }
  };

  const changeFolder = async (nextFolderId: string) => {
    setFolderId(nextFolderId);
    setMessageId("");
    setMessageSearch("");
    if (!nextFolderId) {
      setMessages([]);
      return;
    }
    try {
      const page = await api.listMessages({ folderId: nextFolderId, limit: 100 });
      setMessages(page.items);
    } catch (loadError) {
      onError(errorText(loadError));
    }
  };

  const searchTargetMessages = async () => {
    if (!folderId || !messageSearch.trim()) return;
    setMessageSearchBusy(true);
    onError("");
    try {
      const page = await api.search(messageSearch.trim(), { folderId, sort: "newest", limit: 50 });
      setMessages(page.items.map((hit) => hit.message));
      setMessageId("");
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setMessageSearchBusy(false);
    }
  };

  const openForm = async () => {
    setEditingSchedule(null);
    setTask("analyze");
    setArchiveId("");
    setFolderId("");
    setMessageId("");
    setMessages([]);
    setGmailConnectionId(connections[0]?.id ?? "");
    setResumeId("");
    setName("");
    setMode("unread");
    setIntervalMinutes(60);
    setProvider(settings.ai.activeProvider);
    setModel(settings.ai.providers[settings.ai.activeProvider].model);
    setSkills([...AI_AGENT_SKILL_IDS]);
    setPrompt("");
    setShowForm(true);
    if (archives.length > 0) return;
    try {
      const loaded = await api.listArchives();
      setArchives(loaded);
      const readyArchive = loaded.find((archive) => archive.status !== "importing" && archive.status !== "failed");
      if (readyArchive) await changeArchive(readyArchive.id);
    } catch (loadError) {
      onError(errorText(loadError));
    }
  };

  const openEdit = (schedule: AiSchedule) => {
    setEditingSchedule(schedule);
    setName(schedule.name);
    setTask(schedule.task);
    setArchiveId(schedule.archiveId);
    setFolderId(schedule.folderId);
    setMessageId(schedule.messageId ?? "");
    setMessages(schedule.messageId ? [{
      id: schedule.messageId,
      archiveId: schedule.archiveId,
      folderId: schedule.folderId,
      folderPath: schedule.folderPath,
      subject: schedule.messageSubject ?? "Selected email",
      sender: { name: null, address: "" },
      recipients: [],
      sentAt: null,
      receivedAt: null,
      preview: "",
      hasAttachments: false,
      attachmentCount: 0,
      state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
    }] : []);
    void api.listMessages({ folderId: schedule.folderId, limit: 100 }).then((page) => {
      setMessages((current) => {
        const selected = current.find((entry) => entry.id === schedule.messageId);
        return selected && !page.items.some((entry) => entry.id === selected.id)
          ? [selected, ...page.items]
          : page.items;
      });
    }).catch((loadError) => onError(errorText(loadError)));
    setGmailConnectionId(schedule.gmailConnectionId ?? connections[0]?.id ?? "");
    setResumeId(schedule.resumeId ?? "");
    setMode(schedule.mode);
    setIntervalMinutes(schedule.intervalMinutes);
    setProvider(schedule.provider);
    setModel(schedule.model);
    setSkills(schedule.skills);
    setPrompt(schedule.prompt);
    setShowForm(true);
  };

  const changeProvider = (nextProvider: AiProviderId) => {
    setProvider(nextProvider);
    setModel(settings.ai.providers[nextProvider].model);
  };

  const toggleSkill = (skill: AiAgentSkillId) => {
    setSkills((current) => current.includes(skill)
      ? current.filter((entry) => entry !== skill)
      : [...current, skill]);
  };

  const saveSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSchedule && !folderId) {
      onError("Choose a mailbox for the schedule.");
      return;
    }
    if (skills.length === 0) {
      onError("Choose at least one agent skill.");
      return;
    }
    if (task === "draft_reply" && !gmailConnectionId) {
      onError("Choose a Gmail sending account for the draft task.");
      return;
    }
    onBusy(true);
    onError("");
    try {
      const agentConfig = {
        task,
        messageId: messageId || null,
        gmailConnectionId: task === "draft_reply" ? gmailConnectionId : null,
        resumeId: task === "draft_reply" && resumeId ? resumeId : null,
        provider,
        model: model.trim(),
        skills,
        prompt: prompt.trim()
      };
      const saved = editingSchedule
        ? await api.updateAiSchedule(editingSchedule.id, {
            name: name.trim() || "Untitled schedule",
            folderId,
            mode,
            intervalMinutes,
            ...agentConfig
          })
        : await api.createAiSchedule({
            name: name.trim() || "Untitled schedule",
            folderId,
            mode,
            intervalMinutes,
            ...agentConfig,
            enabled: true
          });
      setSchedules((current) => editingSchedule
        ? current.map((entry) => entry.id === saved.id ? saved : entry)
        : [saved, ...current]);
      setShowForm(false);
      setEditingSchedule(null);
      setName("");
      onNotice(`Schedule "${saved.name}" ${editingSchedule ? "updated" : "created"}.`);
    } catch (createError) {
      onError(errorText(createError));
    } finally {
      onBusy(false);
    }
  };

  const toggleEnabled = async (schedule: AiSchedule) => {
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateAiSchedule(schedule.id, { enabled: !schedule.enabled });
      setSchedules((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
    } catch (updateError) {
      onError(errorText(updateError));
    } finally {
      onBusy(false);
    }
  };

  const runNow = async (schedule: AiSchedule) => {
    onBusy(true);
    onError("");
    try {
      const updated = await api.runAiScheduleNow(schedule.id);
      setSchedules((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      onNotice(`Started "${schedule.name}". Live progress is shown in its status card.`);
    } catch (runError) {
      onError(errorText(runError));
    } finally {
      onBusy(false);
    }
  };

  const remove = async (schedule: AiSchedule) => {
    if (!window.confirm(`Delete the "${schedule.name}" schedule?`)) return;
    onBusy(true);
    onError("");
    try {
      await api.deleteAiSchedule(schedule.id);
      setSchedules((current) => current.filter((entry) => entry.id !== schedule.id));
    } catch (deleteError) {
      onError(errorText(deleteError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <section className="ai-schedules">
      <div className="settings-title-row">
        <div>
          <h3><CalendarClock size={16} /> Scheduled AI agents</h3>
          <p>Analyze mail or create reviewable reply drafts. Each schedule keeps its own target, provider, model, skills, prompt, sending account, and optional resume.</p>
        </div>
        {!showForm && <div className="settings-title-actions">
          <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void load()}>
            <RefreshCw size={16} /> Refresh status
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void openForm()}>
            <Plus size={16} /> Add schedule
          </button>
        </div>}
      </div>

      {showForm && (
        <form className="settings-form ai-agent-form" onSubmit={(event) => void saveSchedule(event)}>
          <h4>{editingSchedule ? `Edit ${editingSchedule.name}` : "New scheduled agent"}</h4>
          <label>Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Inbox unread sweep" disabled={busy} />
          </label>
          <label>Task
            <select value={task} onChange={(event) => setTask(event.target.value as AiScheduleTask)} disabled={busy}>
              <option value="analyze">Analyze email</option>
              <option value="draft_reply">Create work-related reply drafts</option>
            </select>
            {task === "draft_reply" && <small className="settings-hint">Creates local drafts for review. It never sends email or a resume automatically.</small>}
          </label>
          {editingSchedule ? (
            <p className="settings-hint">Mailbox: {editingSchedule.archiveName} / {editingSchedule.folderPath}</p>
          ) : (
            <div className="settings-form-grid">
              <label>Archive
                <select value={archiveId} onChange={(event) => void changeArchive(event.target.value)} disabled={busy}>
                  <option value="" disabled>Choose an archive</option>
                  {archives.map((archive) => <option key={archive.id} value={archive.id}>{archive.name}</option>)}
                </select>
              </label>
              <label>Mailbox
                <select value={folderId} onChange={(event) => void changeFolder(event.target.value)} disabled={busy || folders.length === 0}>
                  <option value="" disabled>Choose a mailbox</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                </select>
              </label>
            </div>
          )}
          <label>Target
            <select value={messageId} onChange={(event) => setMessageId(event.target.value)} disabled={busy || !folderId}>
              <option value="">Entire mailbox ({mode === "unread" ? "unread only" : "all email"})</option>
              {messages.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.subject} — {entry.sender.address || "unknown sender"}</option>
              ))}
            </select>
            <small className="settings-hint">The picker starts with the 100 most recent messages. Search below to find older imported email in this mailbox.</small>
          </label>
          <label>Find a specific email
            <div className="ai-target-search">
              <input
                value={messageSearch}
                onChange={(event) => setMessageSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void searchTargetMessages();
                  }
                }}
                placeholder="Search subject, sender, body, or attachment text"
                disabled={busy || messageSearchBusy || !folderId}
              />
              <button type="button" className="secondary-button" disabled={busy || messageSearchBusy || !folderId || !messageSearch.trim()} onClick={() => void searchTargetMessages()}>
                {messageSearchBusy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Search mailbox
              </button>
            </div>
          </label>
          <div className="settings-form-grid">
            <label>Messages
              <select value={mode} onChange={(event) => setMode(event.target.value as AiScheduleMode)} disabled={busy || Boolean(messageId)}>
                <option value="unread">Only new/unread</option>
                <option value="all">Everything in the mailbox</option>
              </select>
            </label>
            <label>Interval (minutes)
              <input
                type="number"
                min={5}
                max={43200}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                disabled={busy}
              />
              <small className="settings-hint">Runs every {formatInterval(intervalMinutes)}</small>
            </label>
          </div>
          {task === "draft_reply" && (
            <div className="settings-form-grid">
              <label>Gmail sending account
                <select value={gmailConnectionId} onChange={(event) => setGmailConnectionId(event.target.value)} disabled={busy}>
                  <option value="" disabled>Choose an account</option>
                  {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.email}</option>)}
                </select>
                {connections.length === 0 && <small className="settings-hint">Connect or reauthorize Gmail with send permission first.</small>}
              </label>
              <label>Development resume
                <select value={resumeId} onChange={(event) => setResumeId(event.target.value)} disabled={busy}>
                  <option value="">Do not attach a resume</option>
                  {resumes.map((resume) => <option key={resume.id} value={resume.id}>{resume.name} ({resume.filename})</option>)}
                </select>
                <small className="settings-hint">Attached only when the email is classified as a development opportunity.</small>
              </label>
            </div>
          )}
          <div className="settings-form-grid">
            <label>Agent provider
              <select value={provider} onChange={(event) => changeProvider(event.target.value as AiProviderId)} disabled={busy}>
                {AI_PROVIDER_IDS.map((providerId) => (
                  <option key={providerId} value={providerId}>
                    {AI_PROVIDER_LABELS[providerId]}{settings.ai.providers[providerId].configured ? "" : " (key not configured)"}
                  </option>
                ))}
              </select>
            </label>
            <label>Agent model
              <input value={model} onChange={(event) => setModel(event.target.value)} disabled={busy} spellCheck={false} />
            </label>
          </div>
          <fieldset className="ai-skill-picker">
            <legend>Agent skills</legend>
            <div>
              {AI_AGENT_SKILLS.map((skill) => (
                <label key={skill.id} className="settings-checkbox" title={skill.description}>
                  <input
                    type="checkbox"
                    checked={skills.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                    disabled={busy}
                  />
                  <span><strong>{skill.label}</strong><small>{skill.description}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>Agent prompt
            <textarea
              aria-label="Agent prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={12000}
              rows={5}
              disabled={busy}
              placeholder="Optional instructions, e.g. Focus on customer escalations and identify commitments with due dates."
            />
            <small className="settings-hint">Email content remains untrusted; this prompt is appended to the built-in safety and structured-output instructions.</small>
          </label>
          <div className="settings-button-row">
            <button className="primary-button compact" disabled={busy || !folderId || !model.trim() || skills.length === 0 || (task === "draft_reply" && !gmailConnectionId)}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} {editingSchedule ? "Save schedule" : "Create schedule"}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setShowForm(false); setEditingSchedule(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="settings-loading"><LoaderCircle className="spin" size={18} /> Loading schedules</div>
      ) : schedules.length === 0 ? (
        <p className="settings-hint">No scheduled AI agents yet.</p>
      ) : (
        <ul className="ai-schedule-list">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="ai-schedule-row">
              <div className="ai-schedule-copy">
                <strong>{schedule.name}</strong>
                <span>
                  {schedule.task === "draft_reply" ? "Draft replies" : "Analyze"} · {schedule.archiveName} / {schedule.folderPath}
                  {schedule.messageId ? ` / ${schedule.messageSubject ?? "Selected email"}` : ` · ${schedule.mode === "unread" ? "Unread only" : "Everything"}`}
                  {` · Every ${formatInterval(schedule.intervalMinutes)}`}
                </span>
                {schedule.task === "draft_reply" && <small>Send from {schedule.gmailConnectionEmail ?? "Unavailable account"}{schedule.resumeName ? ` · Development resume: ${schedule.resumeName}` : " · No resume"}</small>}
                <small>{AI_PROVIDER_LABELS[schedule.provider]} · {schedule.model} · {schedule.skills.map((skill) => AI_AGENT_SKILLS.find((entry) => entry.id === skill)?.label ?? skill).join(", ")}</small>
                {schedule.prompt && <small className="ai-schedule-prompt" title={schedule.prompt}>Prompt: {schedule.prompt}</small>}
                {schedule.progress
                  ? <AiScheduleProgressReport progress={schedule.progress} task={schedule.task} />
                  : <small>{schedule.lastRunAt
                      ? `Last ran ${formatDate(schedule.lastRunAt)}${schedule.lastRunSummary ? ` — ${schedule.lastRunSummary}` : ""}`
                      : "Never run yet"}</small>}
              </div>
              <div className="ai-schedule-actions">
                <label className="settings-checkbox">
                  <input type="checkbox" checked={schedule.enabled} disabled={busy} onChange={() => void toggleEnabled(schedule)} />
                  <span>Enabled</span>
                </label>
                <button type="button" className="icon-button" disabled={busy || isActiveScheduleRun(schedule.progress)} title={isActiveScheduleRun(schedule.progress) ? "A run is already in progress" : "Run now"} aria-label={`Run ${schedule.name} now`} onClick={() => void runNow(schedule)}>
                  <RefreshCw size={15} />
                </button>
                <button type="button" className="icon-button" disabled={busy || isActiveScheduleRun(schedule.progress)} title="Edit schedule" aria-label={`Edit ${schedule.name}`} onClick={() => openEdit(schedule)}>
                  <Pencil size={15} />
                </button>
                <button type="button" className="icon-button" disabled={busy || isActiveScheduleRun(schedule.progress)} title="Delete schedule" aria-label={`Delete ${schedule.name}`} onClick={() => void remove(schedule)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AiScheduleProgressReport({
  progress,
  task
}: {
  progress: AiScheduleRunProgress;
  task: AiScheduleTask;
}) {
  const active = isActiveScheduleRun(progress);
  const statusLabel = progress.status === "queueing"
    ? "Queueing messages"
    : progress.status === "processing"
      ? "Processing"
      : progress.status === "completed"
        ? "Completed"
        : progress.status === "completed_with_errors"
          ? "Completed with errors"
          : "Failed";
  const elapsedMs = Math.max(0, new Date(progress.completedAt ?? Date.now()).getTime() - new Date(progress.startedAt).getTime());
  const remainingJobs = Math.max(0, progress.queuedJobs - progress.processedJobs);
  const etaMs = active && progress.processedJobs > 0
    ? (elapsedMs / progress.processedJobs) * remainingJobs
    : null;

  return (
    <div className={`ai-run-progress ${progress.status}`}>
      <div className="ai-run-progress-header">
        <strong>{active && <LoaderCircle className="spin" size={14} />} {statusLabel}</strong>
        <span>{progress.percent}%</span>
      </div>
      <div
        className="ai-run-progress-track"
        role="progressbar"
        aria-label="AI schedule progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <strong className="ai-run-progress-summary">
        {progress.status === "queueing"
          ? `${progress.totalMessages.toLocaleString()} messages selected`
          : `${progress.processedJobs.toLocaleString()} of ${progress.queuedJobs.toLocaleString()} jobs processed`}
      </strong>
      <div className="ai-run-progress-counts">
        <span>{progress.queued.toLocaleString()} queued</span>
        <span>{progress.running.toLocaleString()} running</span>
        <span>{progress.completed.toLocaleString()} completed</span>
        <span className={progress.failed ? "error" : ""}>{progress.failed.toLocaleString()} failed</span>
        {progress.cancelled > 0 && <span>{progress.cancelled.toLocaleString()} cancelled</span>}
      </div>
      {(progress.skippedMessages > 0 || progress.enqueueErrors > 0 || (task === "draft_reply" && progress.draftsCreated > 0)) && (
        <div className="ai-run-progress-details">
          {progress.skippedMessages > 0 && <span>{progress.skippedMessages.toLocaleString()} already up to date</span>}
          {progress.enqueueErrors > 0 && <span className="error">{progress.enqueueErrors.toLocaleString()} could not be queued</span>}
          {task === "draft_reply" && progress.draftsCreated > 0 && <span>{progress.draftsCreated.toLocaleString()} reviewable drafts created</span>}
        </div>
      )}
      <small>
        Started {formatDate(progress.startedAt)} · elapsed {formatDuration(elapsedMs)}
        {etaMs !== null && remainingJobs > 0 ? ` · estimated ${formatDuration(etaMs)} remaining` : ""}
      </small>
      {progress.error && <small className="ai-run-progress-error">{progress.error}</small>}
    </div>
  );
}

function isActiveScheduleRun(progress: AiScheduleRunProgress | null): boolean {
  return Boolean(progress && ["queueing", "processing"].includes(progress.status));
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function UsersPanel({
  api,
  users,
  currentUserId,
  busy,
  onBusy,
  onUsers,
  onError,
  onNotice
}: {
  api: ApiClient;
  users: UserSummary[];
  currentUserId: string;
  busy: boolean;
  onBusy(value: boolean): void;
  onUsers(value: UserSummary[]): void;
  onError(value: string): void;
  onNotice(value: string): void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [pin, setPin] = useState("");
  const [resetUser, setResetUser] = useState<UserSummary | null>(null);
  const [resetPin, setResetPin] = useState("");

  const replaceUser = (updated: UserSummary) => {
    onUsers(users.map((user) => user.id === updated.id ? updated : user));
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const created = await api.createUser({ username, displayName, role, pin });
      onUsers([...users, created].sort((a, b) => a.username.localeCompare(b.username)));
      setUsername("");
      setDisplayName("");
      setPin("");
      onNotice(`User ${created.username} created.`);
    } catch (createError) {
      onError(errorText(createError));
    } finally {
      onBusy(false);
    }
  };

  const update = async (user: UserSummary, patch: { role?: "admin" | "user"; isActive?: boolean; pin?: string }) => {
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateUser(user.id, patch);
      replaceUser(updated);
      onNotice(`User ${updated.username} updated. Existing sessions were revoked.`);
    } catch (updateError) {
      onError(errorText(updateError));
    } finally {
      onBusy(false);
    }
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetUser) return;
    await update(resetUser, { pin: resetPin });
    setResetUser(null);
    setResetPin("");
  };

  return (
    <>
      <h3>Users</h3>
      <p>Named accounts make audit records attributable. Administrators manage users and settings; users can manage mail but cannot open this panel.</p>
      <div className="settings-table-wrap">
        <table className="settings-table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.displayName}</strong><small>{user.username}{user.id === currentUserId ? " · current" : ""}</small></td>
                <td>
                  <select value={user.role} disabled={busy} onChange={(event) => void update(user, { role: event.target.value as "admin" | "user" })} aria-label={`Role for ${user.username}`}>
                    <option value="user">User</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td><span className={`status-text ${user.isActive ? "active" : "inactive"}`}>{user.isActive ? "Active" : "Disabled"}</span></td>
                <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}</td>
                <td className="settings-actions">
                  <button className="icon-button subtle" onClick={() => void update(user, { isActive: !user.isActive })} disabled={busy} title={user.isActive ? "Disable user" : "Enable user"} aria-label={`${user.isActive ? "Disable" : "Enable"} ${user.username}`}><Power size={15} /></button>
                  <button className="icon-button subtle" onClick={() => { setResetUser(user); setResetPin(""); }} disabled={busy} title="Reset PIN" aria-label={`Reset PIN for ${user.username}`}><KeyRound size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resetUser && (
        <form className="settings-inline-form" onSubmit={(event) => void reset(event)}>
          <strong>Reset PIN for {resetUser.username}</strong>
          <input type="password" inputMode="numeric" pattern="[0-9]{4,12}" value={resetPin} onChange={(event) => setResetPin(event.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="New 4 to 12 digit PIN" autoFocus />
          <button className="primary-button" disabled={busy || resetPin.length < 4}>Reset PIN</button>
          <button type="button" className="text-button" onClick={() => setResetUser(null)}>Cancel</button>
        </form>
      )}
      <form className="settings-create-user" onSubmit={(event) => void create(event)}>
        <h4><UserPlus size={17} /> Add user</h4>
        <div className="settings-form-grid">
          <label>Username<input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9._-]{2,63}" required /></label>
          <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} required /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")}><option value="user">User</option><option value="admin">Admin</option></select></label>
          <label>PIN<input type="password" inputMode="numeric" pattern="[0-9]{4,12}" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))} required /></label>
        </div>
        <button className="primary-button" disabled={busy || username.length < 3 || !displayName.trim() || pin.length < 4}><UserPlus size={16} /> Create user</button>
      </form>
    </>
  );
}

function SecurityPanel({
  api,
  settings,
  busy,
  onBusy,
  onError,
  onSignedOut
}: {
  api: ApiClient;
  settings: AdminSettings;
  busy: boolean;
  onBusy(value: boolean): void;
  onError(value: string): void;
  onSignedOut(): void;
}) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  const changePin = async (event: FormEvent) => {
    event.preventDefault();
    if (newPin !== confirmPin) {
      onError("New PIN confirmation does not match");
      return;
    }
    onBusy(true);
    onError("");
    try {
      await api.changePin(currentPin, newPin);
      onSignedOut();
    } catch (changeError) {
      onError(errorText(changeError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>Security</h3>
      <p>Sessions are stored as token hashes, bound to the login IP address, and expire after {settings.security.sessionLifetimeMinutes} minutes. Closing the client removes its browser-held session token.</p>
      {settings.security.defaultPinWarning && (
        <div className="settings-warning"><AlertTriangle size={17} /><span>The first-run administrator PIN is still active.</span></div>
      )}
      <form className="settings-form security-form" onSubmit={(event) => void changePin(event)}>
        <h4><KeyRound size={17} /> Change my PIN</h4>
        <label>Current PIN<input type="password" inputMode="numeric" value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 12))} /></label>
        <label>New PIN<input type="password" inputMode="numeric" value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 12))} /></label>
        <label>Confirm new PIN<input type="password" inputMode="numeric" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 12))} /></label>
        <button className="primary-button" disabled={busy || currentPin.length < 4 || newPin.length < 4 || confirmPin.length < 4}><KeyRound size={16} /> Change PIN and sign out</button>
      </form>
    </>
  );
}

function AuditPanel({ api, onError }: { api: ApiClient; onError(value: string): void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [action, setAction] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [outcome, setOutcome] = useState<"all" | "success" | "failure">("all");
  const [loading, setLoading] = useState(false);

  const filters = useMemo(() => ({
    username: username.trim() || undefined,
    action: action.trim() || undefined,
    ipAddress: ipAddress.trim() || undefined,
    success: outcome === "all" ? undefined : outcome === "success"
  }), [username, action, ipAddress, outcome]);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    onError("");
    try {
      const page = await api.audit({
        ...filters,
        cursor: append ? nextCursor ?? undefined : undefined,
        limit: 50
      });
      setEvents((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      onError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [api, filters, nextCursor, onError]);

  useEffect(() => { void load(false); }, []);

  return (
    <>
      <div className="settings-title-row"><div><h3>Audit</h3><p>Every API and desktop operation records the user, outcome, IP address, route, and user agent. PINs, authorization tokens, and email bodies are never recorded.</p></div><button className="secondary-button" onClick={() => void api.downloadAudit()}><Download size={16} /> Export JSON</button></div>
      <form className="audit-filters" onSubmit={(event) => { event.preventDefault(); void load(false); }}>
        <label>User<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" /></label>
        <label>Action<input value={action} onChange={(event) => setAction(event.target.value)} placeholder="Route or action" /></label>
        <label>IP address<input value={ipAddress} onChange={(event) => setIpAddress(event.target.value)} placeholder="Address" /></label>
        <label>Outcome<select value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)}><option value="all">All</option><option value="success">Success</option><option value="failure">Failure</option></select></label>
        <button className="secondary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Apply</button>
      </form>
      <div className="settings-table-wrap audit-table-wrap">
        <table className="settings-table audit-table">
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Result</th><th>IP address</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatDate(event.createdAt)}</td>
                <td><strong>{event.username ?? "Unauthenticated"}</strong><small>{event.role ?? "none"}</small></td>
                <td><strong>{event.action}</strong><small title={event.userAgent ?? undefined}>{event.path ?? ""}{event.userAgent ? ` · ${event.userAgent}` : ""}</small></td>
                <td><span className={`audit-outcome ${event.success ? "success" : "failure"}`}>{event.statusCode} {event.success ? "Success" : "Failed"}</span></td>
                <td><code>{event.ipAddress}</code></td>
              </tr>
            ))}
            {!loading && events.length === 0 && <tr><td colSpan={5} className="settings-empty">No audit records match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {nextCursor && <button className="secondary-button audit-more" onClick={() => void load(true)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <ScrollText size={16} />} Load more</button>}
    </>
  );
}

function parseDesktopOAuthJson(text: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The selected OAuth file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The selected OAuth file is not a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.web && !root.installed) {
    throw new Error("This is a Web OAuth client. Create and download a Google OAuth client with application type Desktop app.");
  }
  if (!root.installed || typeof root.installed !== "object") {
    throw new Error("The selected file does not contain Desktop OAuth credentials under installed");
  }
  const installed = root.installed as Record<string, unknown>;
  const clientId = typeof installed.client_id === "string" ? installed.client_id.trim() : "";
  const clientSecret = typeof installed.client_secret === "string" ? installed.client_secret.trim() : "";
  if (!clientId) throw new Error("The selected Desktop OAuth file does not contain client_id");
  return { clientId, clientSecret };
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The settings operation failed";
}
