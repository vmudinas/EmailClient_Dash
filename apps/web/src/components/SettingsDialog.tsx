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
  BrainCircuit,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  KeyRound,
  LoaderCircle,
  MailCheck,
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
  AdminSettings,
  AuditEvent,
  AuthSessionInfo,
  DatabaseProvider,
  UserSummary
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

type SettingsSection = "database" | "gmail" | "ai" | "users" | "security" | "audit";

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
  { id: "ai", label: "AI", icon: BrainCircuit },
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
  const [loadedFilename, setLoadedFilename] = useState("");
  const environmentManaged = settings.gmail.source === "environment";

  useEffect(() => {
    setClientId(settings.gmail.clientId);
    setClientSecret("");
    setClearClientSecret(false);
  }, [settings.gmail]);

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
        clearClientSecret
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
      <div className="settings-warning neutral"><MailCheck size={17} /><span>Changing the OAuth client may require existing Gmail accounts to be disconnected and authorized again.</span></div>
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
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(settings.ai.enabled);
  const [model, setModel] = useState(settings.ai.model);
  const [dailyLimit, setDailyLimit] = useState(settings.ai.dailyRequestLimit);
  const [monthlyLimit, setMonthlyLimit] = useState(settings.ai.monthlyRequestLimit);
  const environmentManaged = settings.ai.source === "environment";

  useEffect(() => {
    setApiKey("");
    setEnabled(settings.ai.enabled);
    setModel(settings.ai.model);
    setDailyLimit(settings.ai.dailyRequestLimit);
    setMonthlyLimit(settings.ai.monthlyRequestLimit);
  }, [settings.ai]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const updated = await api.updateAiSettings({
        clearApiKey: false,
        enabled,
        model: model.trim(),
        dailyRequestLimit: dailyLimit,
        monthlyRequestLimit: monthlyLimit,
        ...(apiKey.trim() && !environmentManaged ? { apiKey: apiKey.trim() } : {})
      });
      onSettings(updated);
      setApiKey("");
      onNotice("AI configuration saved.");
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      onBusy(false);
    }
  };

  const test = async () => {
    onBusy(true);
    onError("");
    try {
      await api.testAiConnection();
      onNotice(`OpenAI connection succeeded for ${settings.ai.model}.`);
    } catch (testError) {
      onError(errorText(testError));
    } finally {
      onBusy(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm("Remove the saved OpenAI API key and disable AI features?")) return;
    onBusy(true);
    onError("");
    try {
      onSettings(await api.clearAiApiKey());
      onNotice("Saved OpenAI API key removed.");
    } catch (clearError) {
      onError(errorText(clearError));
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <h3>AI</h3>
      <p>Email analysis uses an OpenAI API project key. A ChatGPT subscription does not provide API billing or an API key.</p>
      {settings.ai.configurationError && (
        <div className="settings-warning"><AlertTriangle size={17} /><span>{settings.ai.configurationError}</span></div>
      )}
      <div className={`settings-warning ${settings.ai.configured && settings.ai.enabled ? "configured" : ""}`}>
        {settings.ai.configured && settings.ai.enabled ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <span>{!settings.ai.configured
          ? "OpenAI API key not configured."
          : settings.ai.enabled
            ? `AI analysis enabled with ${settings.ai.model}.`
            : "API key configured, but AI analysis is disabled."}</span>
      </div>
      <div className="settings-warning neutral"><ShieldCheck size={17} /><span>Analyzed email text is sent to OpenAI. Requests use <code>store: false</code>; API keys and email bodies are excluded from diagnostics and audit records.</span></div>
      {environmentManaged && (
        <div className="settings-warning neutral"><KeyRound size={17} /><span>The API key comes from OPENAI_API_KEY. Model and usage limits remain editable here.</span></div>
      )}
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <label className="settings-checkbox settings-toggle-row">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />
          <span>Enable AI analysis</span>
        </label>
        <label>
          OpenAI API key {settings.ai.apiKeyConfigured ? "(saved)" : ""}
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy || environmentManaged}
            placeholder={settings.ai.apiKeyConfigured ? "Leave blank to keep the saved key" : "sk-proj-..."}
          />
        </label>
        <label>
          Analysis model
          <input value={model} onChange={(event) => setModel(event.target.value)} disabled={busy} spellCheck={false} />
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
          <button className="primary-button" disabled={busy || !model.trim() || dailyLimit < 1 || monthlyLimit < 1}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save AI configuration
          </button>
          <button type="button" className="secondary-button" disabled={busy || !settings.ai.configured} onClick={() => void test()}>
            <Sparkles size={16} /> Test connection
          </button>
          {settings.ai.source === "admin" && (
            <button type="button" className="danger-button" disabled={busy} onClick={() => void clearKey()}><Trash2 size={16} /> Remove key</button>
          )}
        </div>
      </form>
      <dl className="settings-definitions">
        <div><dt>Source</dt><dd>{settings.ai.source === "admin" ? "Admin settings" : settings.ai.source === "environment" ? "Environment" : "None"}</dd></div>
        <div><dt>Today</dt><dd>{settings.ai.usage.todayRequests.toLocaleString()} requests · {(settings.ai.usage.todayInputTokens + settings.ai.usage.todayOutputTokens).toLocaleString()} tokens</dd></div>
        <div><dt>This month</dt><dd>{settings.ai.usage.monthRequests.toLocaleString()} requests · {(settings.ai.usage.monthInputTokens + settings.ai.usage.monthOutputTokens).toLocaleString()} tokens</dd></div>
        <div><dt>Settings file</dt><dd><code>{settings.ai.settingsPath}</code></dd></div>
      </dl>
    </>
  );
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
