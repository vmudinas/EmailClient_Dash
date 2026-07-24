import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Banknote,
  Building2,
  Camera,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Copy,
  CreditCard,
  Download,
  FileText,
  Home,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Upload,
  Users,
  Wrench,
  X
} from "lucide-react";
import type {
  ManagedProperty,
  GmailConnection,
  PropertyPayment,
  PropertyPaymentMethod,
  PropertyPaymentConfiguration,
  PropertyPaymentProvider,
  PropertyBackupSummary,
  PropertyPortfolioOverview,
  PropertyPlatformOverview,
  PropertyServiceRequestStatus,
  UserSummary
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

type PropertyTab = "overview" | "properties" | "people" | "requests" | "payments" | "documents" | "accounting" | "communications";
type PropertyDialog = "property" | "unit" | "tenant" | "lease" | "request" | "charge" | "payment" | "document" | "schedule" | "adjustment" | "integrations" | null;

interface PropertyManagementViewProps {
  api: ApiClient;
  readOnly: boolean;
  isAdmin: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

const EMPTY_OVERVIEW: PropertyPortfolioOverview = {
  mode: "manager",
  generatedAt: "",
  stats: {
    propertyCount: 0,
    occupiedCount: 0,
    openRequestCount: 0,
    outstandingBalanceCents: 0,
    paidThisMonthCents: 0
  },
  properties: [],
  tenants: [],
  leases: [],
  serviceRequests: [],
  rentCharges: [],
  payments: [],
  paymentConfiguration: {
    stripe: { configured: false, methods: ["card", "apple_pay", "google_pay", "ach"] },
    paypal: { configured: false, environment: "sandbox", methods: ["paypal"] },
    zelle: { configured: false, recipient: null, note: "" },
    appleCash: { configured: false, recipient: null, note: "" },
    manual: { configured: true, methods: ["cash", "check", "other"] }
  }
};

const EMPTY_PLATFORM: PropertyPlatformOverview = {
  organizations: [], memberships: [], units: [], invitations: [], documents: [],
  requestComments: [], requestStatusHistory: [], requestAttachments: [], rentSchedules: [],
  ledgerEntries: [], receipts: [], notificationJobs: [], deliveryAttempts: [], consents: [],
  integrations: {
    stripeConfigured: false, stripeSource: "none", stripeWebhookConfigured: false,
    paypalConfigured: false, paypalSource: "none", paypalEnvironment: "sandbox",
    paypalWebhookConfigured: false, zelleRecipient: null, appleCashRecipient: null, appleCashNote: "", twilioConfigured: false,
    twilioSource: "none", gmailConnectionId: null
  },
  report: {
    generatedAt: "", totalChargesCents: 0, totalPaymentsCents: 0, totalAdjustmentsCents: 0,
    outstandingCents: 0, overdueCharges: 0, openRequests: 0, expiringLeases: 0, queuedNotifications: 0
  }
};

const REQUEST_STATUSES: PropertyServiceRequestStatus[] = [
  "submitted",
  "triaged",
  "scheduled",
  "in_progress",
  "waiting",
  "completed",
  "cancelled"
];

export function PropertyManagementView({
  api,
  readOnly,
  isAdmin,
  onError,
  onNotice
}: PropertyManagementViewProps) {
  const [overview, setOverview] = useState<PropertyPortfolioOverview>(EMPTY_OVERVIEW);
  const [platform, setPlatform] = useState<PropertyPlatformOverview>(EMPTY_PLATFORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<PropertyTab>("overview");
  const [dialog, setDialog] = useState<PropertyDialog>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [gmailConnections, setGmailConnections] = useState<GmailConnection[]>([]);
  const [backups, setBackups] = useState<PropertyBackupSummary[]>([]);
  const [paymentInstructions, setPaymentInstructions] = useState("");
  const [paymentChargeId, setPaymentChargeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, platformOverview] = await Promise.all([
        api.propertyOverview(),
        api.propertyPlatformOverview()
      ]);
      setOverview(next);
      setPlatform(platformOverview);
      if (isAdmin && next.mode === "manager") {
        const [nextUsers, connections, nextBackups] = await Promise.all([
          api.listUsers(),
          api.listGmailConnections(),
          api.listPropertyBackups()
        ]);
        setUsers(nextUsers);
        setGmailConnections(connections);
        setBackups(nextBackups);
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [api, isAdmin, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stripe and PayPal return to /properties?payment=<id>&result=success|cancelled. Pull the final
  // status from the provider straight away so the row is correct without waiting for the webhook,
  // then strip the parameters so a refresh does not re-run the sync.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("payment");
    const result = params.get("result");
    if (!paymentId) return;
    params.delete("payment");
    params.delete("result");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    if (result === "cancelled") {
      onNotice("Payment was cancelled. Nothing has been charged.");
      return;
    }
    void (async () => {
      try {
        const payment = await api.syncPropertyPayment(paymentId);
        onNotice(payment.status === "succeeded"
          ? "Payment confirmed. A receipt has been recorded."
          : "Payment is still being confirmed by the provider.");
      } catch (error) {
        onError(errorMessage(error));
      } finally {
        await load();
      }
    })();
  }, [api, load, onNotice, onError]);

  useEffect(() => {
    let cancelled = false;
    const loaded: string[] = [];
    void Promise.all(overview.properties.map(async (property) => {
      if (!property.imageUrl) return;
      try {
        const blob = await api.propertyPhoto(property.id);
        const url = URL.createObjectURL(blob);
        loaded.push(url);
        if (!cancelled) setPhotoUrls((current) => ({ ...current, [property.id]: url }));
      } catch {
        return;
      }
    }));
    return () => {
      cancelled = true;
      for (const url of loaded) URL.revokeObjectURL(url);
    };
  }, [api, overview.properties]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await operation();
      setDialog(null);
      onNotice(success);
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const activeLeases = useMemo(
    () => overview.leases.filter((lease) => lease.status === "active" || lease.status === "upcoming"),
    [overview.leases]
  );
  const manager = overview.mode === "manager";
  // Out-of-band payments (Zelle, Apple Cash, cash/check) are settled by the tenant sending money
  // themselves, so the recipient and reference must stay visible until a manager confirms receipt —
  // not just in the banner shown once at checkout.
  const awaitingInstructionPayments = useMemo(
    () => overview.payments.filter((payment) =>
      INSTRUCTION_PROVIDERS.includes(payment.provider)
      && !["succeeded", "refunded", "cancelled", "failed"].includes(payment.status)),
    [overview.payments]
  );
  const paymentCharge = paymentChargeId
    ? overview.rentCharges.find((charge) => charge.id === paymentChargeId) ?? null
    : null;
  const openPayment = (chargeId: string | null = null) => {
    setPaymentChargeId(chargeId);
    setDialog("payment");
  };

  const createInvitation = async (tenantId: string) => {
    setBusy(true);
    try {
      const invitation = await api.createPropertyTenantInvitation({ tenantId, expiresHours: 48 });
      if (invitation.invitationUrl) {
        await navigator.clipboard.writeText(invitation.invitationUrl);
        onNotice("Tenant invitation link copied. It expires in 48 hours.");
      }
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runAutomation = async () => {
    setBusy(true);
    try {
      const result = await api.runPropertyAutomation();
      onNotice(result.alreadyRunning
        ? "Property automation is already running."
        : `Automation finished: ${result.chargesCreated} charges, ${result.providerEventsProcessed} provider events, ${result.notificationsCompleted} notifications, ${result.notificationsFailed} failed.`);
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createBackup = async () => {
    setBusy(true);
    try {
      const backup = await api.createPropertyBackup();
      onNotice(`Backup created: ${formatBytes(backup.sizeBytes)} across ${backup.fileCount} files.`);
      await load();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !overview.generatedAt) {
    return <div className="property-loading"><LoaderCircle className="spin" size={24} /> Loading properties…</div>;
  }

  return (
    <section className="property-view">
      <header className="property-hero">
        <div>
          <span className="eyebrow">{manager ? "Property management" : "Tenant portal"}</span>
          <h1>{manager ? "Portfolio command center" : "Your home and rent"}</h1>
          <p>{manager
            ? "Properties, occupants, maintenance, charges, and verified payment history in one place."
            : "Review your lease, pay rent, and track service requests without access to the manager's mailbox."}</p>
        </div>
        <button className="secondary-button property-refresh" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={17} /> Refresh
        </button>
      </header>

      <div className="property-stats" aria-label="Portfolio summary">
        <Stat icon={<Building2 size={20} />} label="Properties" value={String(overview.stats.propertyCount)} detail={`${overview.stats.occupiedCount} occupied`} />
        <Stat icon={<Wrench size={20} />} label="Open requests" value={String(overview.stats.openRequestCount)} detail="Needs attention" tone={overview.stats.openRequestCount > 0 ? "warning" : "normal"} />
        <Stat icon={<Banknote size={20} />} label="Outstanding" value={money(overview.stats.outstandingBalanceCents)} detail="Open rent charges" tone={overview.stats.outstandingBalanceCents > 0 ? "warning" : "normal"} />
        <Stat icon={<CheckCircle2 size={20} />} label="Paid this month" value={money(overview.stats.paidThisMonthCents)} detail="Successful payments" tone="success" />
      </div>

      <nav className="property-tabs" aria-label="Property sections">
        <PropertyTabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<Home size={17} />} label="Overview" />
        <PropertyTabButton active={tab === "properties"} onClick={() => setTab("properties")} icon={<Building2 size={17} />} label="Properties" />
        <PropertyTabButton active={tab === "people"} onClick={() => setTab("people")} icon={<Users size={17} />} label={manager ? "Tenants & leases" : "Lease"} />
        <PropertyTabButton active={tab === "requests"} onClick={() => setTab("requests")} icon={<Wrench size={17} />} label="Requests" count={overview.stats.openRequestCount} />
        <PropertyTabButton active={tab === "payments"} onClick={() => setTab("payments")} icon={<CreditCard size={17} />} label="Payments" />
        <PropertyTabButton active={tab === "documents"} onClick={() => setTab("documents")} icon={<FileText size={17} />} label="Documents" />
        <PropertyTabButton active={tab === "accounting"} onClick={() => setTab("accounting")} icon={<Banknote size={17} />} label="Accounting" />
        <PropertyTabButton active={tab === "communications"} onClick={() => setTab("communications")} icon={<Send size={17} />} label="Communications" count={platform.report.queuedNotifications} />
      </nav>

      {tab === "overview" && (
        <div className="property-dashboard-grid">
          <Panel title="Properties" action={manager && !readOnly ? <ActionButton label="Add property" onClick={() => setDialog("property")} /> : null}>
            <PropertyCards properties={overview.properties} photoUrls={photoUrls} compact />
          </Panel>
          <Panel title="Recent service requests" action={!readOnly ? <ActionButton label="New request" onClick={() => setDialog("request")} /> : null}>
            <RequestList requests={overview.serviceRequests.slice(0, 5)} />
          </Panel>
          <Panel title="Rent and payments" action={!readOnly ? <ActionButton label={manager ? "Record payment" : "Pay rent or fee"} onClick={() => openPayment()} /> : null}>
            <div className="rent-summary-list">
              {overview.rentCharges.slice(0, 5).map((charge) => (
                <div key={charge.id}>
                  <span><strong>{charge.propertyName}</strong><small>{charge.description} · due {dateLabel(charge.dueDate)}</small></span>
                  <span className={charge.balanceCents > 0 ? "amount-due" : "amount-paid"}>{money(charge.balanceCents)}</span>
                </div>
              ))}
              {overview.rentCharges.length === 0 && <EmptyState text="No rent charges yet." />}
            </div>
          </Panel>
          <Panel title="Payment rails">
            <ProviderGrid overview={overview} />
          </Panel>
        </div>
      )}

      {tab === "properties" && (
        <div className="property-dashboard-grid">
          <Panel
            title={manager ? "Managed properties" : "Your property"}
            action={manager && !readOnly ? <ActionButton label="Add property" onClick={() => setDialog("property")} /> : null}
            wide
          >
            <PropertyCards
              properties={overview.properties}
              photoUrls={photoUrls}
              onPhoto={manager && !readOnly ? async (property, file) => {
                await run(() => api.uploadPropertyPhoto(property.id, file), `${property.name} photo updated`);
              } : undefined}
            />
          </Panel>
          <Panel title="Units" action={manager && !readOnly ? <ActionButton label="Add unit" onClick={() => setDialog("unit")} /> : null} wide>
            <div className="property-unit-list">
              {platform.units.map((unit) => <article key={unit.id}><Home size={18} /><div><strong>{unit.propertyName} · {unit.name}</strong><span>{unit.bedrooms ?? "—"} bed · {unit.bathrooms ?? "—"} bath{unit.monthlyRentCents === null ? "" : ` · ${money(unit.monthlyRentCents)}/month`}</span></div><StatusBadge value={unit.status} /></article>)}
              {platform.units.length === 0 && <EmptyState text="No units are available." />}
            </div>
          </Panel>
        </div>
      )}

      {tab === "people" && (
        <div className="property-dashboard-grid">
          {manager && (
            <Panel title="Tenants" action={!readOnly ? <ActionButton label="Add tenant" onClick={() => setDialog("tenant")} /> : null}>
              <div className="people-list">
                {overview.tenants.map((tenant) => (
                  <div key={tenant.id}>
                    <span className="person-avatar">{initials(tenant.displayName)}</span>
                    <span><strong>{tenant.displayName}</strong><small>{tenant.email}{tenant.phone ? ` · ${tenant.phone}` : ""}</small></span>
                    <StatusBadge value={tenant.status} />
                    {!tenant.linkedUserId && !readOnly && <button className="secondary-button compact" disabled={busy} onClick={() => void createInvitation(tenant.id)}><Send size={14} /> Invite</button>}
                    {tenant.linkedUserId && <small className="portal-linked">Portal linked</small>}
                  </div>
                ))}
                {overview.tenants.length === 0 && <EmptyState text="Add a tenant, then link a lease." />}
              </div>
            </Panel>
          )}
          <Panel title="Leases" action={manager && !readOnly ? <ActionButton label="Add lease" onClick={() => setDialog("lease")} /> : null} wide={!manager}>
            <div className="lease-list">
              {overview.leases.map((lease) => (
                <article key={lease.id}>
                  <div><strong>{lease.propertyName}</strong><span>{lease.tenantName}</span></div>
                  <div><small>Lease term</small><span>{dateLabel(lease.startDate)} – {dateLabel(lease.endDate)}</span></div>
                  <div><small>Monthly rent</small><span>{money(lease.monthlyRentCents)} · due day {lease.dueDay}</span></div>
                  <StatusBadge value={lease.status} />
                </article>
              ))}
              {overview.leases.length === 0 && <EmptyState text="No leases are configured." />}
            </div>
          </Panel>
        </div>
      )}

      {tab === "requests" && (
        <Panel title="Service requests" action={!readOnly ? <ActionButton label="New request" onClick={() => setDialog("request")} /> : null} wide>
          <div className="request-table">
            {overview.serviceRequests.map((request) => (
              <article key={request.id}>
                <div className={`request-priority ${request.priority}`}>{request.priority}</div>
                <div className="request-main"><strong>{request.title}</strong><span>{request.propertyName}{request.tenantName ? ` · ${request.tenantName}` : ""}</span><p>{request.description}</p></div>
                <div className="request-meta"><small>{request.category}</small><span>{dateTimeLabel(request.createdAt)}</span></div>
                {manager && !readOnly ? (
                  <select
                    value={request.status}
                    disabled={busy}
                    onChange={(event) => void run(
                      () => api.updatePropertyServiceRequest(request.id, { status: event.target.value as PropertyServiceRequestStatus }),
                      "Service request updated"
                    )}
                    aria-label={`Status for ${request.title}`}
                  >
                    {REQUEST_STATUSES.map((status) => <option key={status} value={status}>{label(status)}</option>)}
                  </select>
                ) : <StatusBadge value={request.status} />}
                <div className="request-activity">
                  <div className="request-timeline">
                    {platform.requestStatusHistory.filter((event) => event.requestId === request.id).map((event) => (
                      <small key={event.id}><CheckCircle2 size={13} /> {event.fromStatus ? `${label(event.fromStatus)} → ` : "Created as "}{label(event.toStatus)} · {dateTimeLabel(event.createdAt)}</small>
                    ))}
                    {platform.requestComments.filter((comment) => comment.requestId === request.id).map((comment) => (
                      <div key={comment.id}><strong>{comment.authorName}</strong><span>{comment.body}</span><small>{dateTimeLabel(comment.createdAt)}</small></div>
                    ))}
                    {platform.requestAttachments.filter((attachment) => attachment.requestId === request.id).map((attachment) => (
                      <button key={attachment.id} className="text-button request-file" onClick={() => void openPropertyBlob(
                        () => api.propertyRequestAttachmentBlob(attachment.id, true), attachment.filename, true, onError
                      )}><FileText size={14} /> {attachment.filename}</button>
                    ))}
                  </div>
                  {!readOnly && <div className="request-compose-row">
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const input = form.elements.namedItem("comment") as HTMLInputElement;
                      const body = input.value.trim();
                      if (!body) return;
                      void run(() => api.addPropertyRequestComment(request.id, { body, tenantVisible: true }), "Comment added");
                      form.reset();
                    }}><input name="comment" placeholder={manager ? "Reply to tenant…" : "Message property manager…"} aria-label={`Comment on ${request.title}`} /><button className="secondary-button compact" disabled={busy}><Send size={14} /> Send</button></form>
                    <label className="secondary-button compact file-action"><Upload size={14} /> Photo, video, or file<input type="file" accept=".pdf,.doc,.docx,.txt,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(() => api.uploadPropertyRequestAttachment(request.id, file), "Attachment uploaded"); event.currentTarget.value = ""; }} /></label>
                  </div>}
                </div>
              </article>
            ))}
            {overview.serviceRequests.length === 0 && <EmptyState text="No service requests." />}
          </div>
        </Panel>
      )}

      {tab === "payments" && (
        <div className="property-payments-layout">
          <Panel title="Payment methods" wide>
            <ProviderGrid overview={overview} detailed />
          </Panel>
          <Panel title="Rent charges" action={manager && !readOnly ? <ActionButton label="Add charge" onClick={() => setDialog("charge")} /> : null}>
            <div className="charge-list">
              {overview.rentCharges.map((charge) => (
                <article key={charge.id}>
                  <div><strong>{charge.description}</strong><span>{charge.propertyName} · due {dateLabel(charge.dueDate)}</span></div>
                  <div className="charge-amount"><strong>{money(charge.balanceCents)}</strong><small>of {money(charge.amountCents)}</small></div>
                  <StatusBadge value={charge.status} />
                  {!manager && !readOnly && charge.balanceCents > 0 && <button className="primary-button compact" disabled={busy} onClick={() => openPayment(charge.id)}><CreditCard size={14} /> Pay</button>}
                </article>
              ))}
              {overview.rentCharges.length === 0 && <EmptyState text="No rent charges." />}
            </div>
          </Panel>
          {awaitingInstructionPayments.length > 0 && (
            <Panel title="How to pay" wide>
              <PaymentInstructionList
                payments={awaitingInstructionPayments}
                configuration={overview.paymentConfiguration}
                onCopied={(what) => onNotice(`${what} copied`)}
              />
            </Panel>
          )}
          <Panel title="Payment history" action={!readOnly ? <ActionButton label={manager ? "Record payment" : "Pay rent or fee"} onClick={() => openPayment()} /> : null}>
            <PaymentHistory
              payments={overview.payments}
              manager={manager}
              busy={busy}
              onSync={(payment) => void run(() => api.syncPropertyPayment(payment.id), "Payment status synchronized")}
              onMarkPaid={(payment) => void run(() => api.updatePropertyPayment(payment.id, {
                status: "succeeded",
                paidAt: new Date().toISOString()
              }), "Payment marked successful")}
              onRefund={(payment) => {
                const reason = window.prompt("Refund reason");
                if (!reason?.trim()) return;
                const amount = window.prompt("Refund amount", (payment.amountCents / 100).toFixed(2));
                if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return onError("Enter a valid refund amount");
                void run(() => api.refundPropertyPayment(payment.id, {
                  amountCents: Math.round(Number(amount) * 100),
                  reason: reason.trim()
                }), "Refund recorded");
              }}
            />
          </Panel>
        </div>
      )}

      {tab === "documents" && (
        <Panel title="Property documents" action={manager && !readOnly ? <ActionButton label="Upload document" onClick={() => setDialog("document")} /> : null} wide>
          <div className="property-document-list">
            {platform.documents.map((document) => (
              <article key={document.id}>
                <span className="property-file-icon"><FileText size={20} /></span>
                <div><strong>{document.title}</strong><span>{document.propertyName} · {document.category} · version {document.latestVersion.version}</span><small>{document.latestVersion.filename} · {formatBytes(document.latestVersion.sizeBytes)} · {label(document.visibility)}</small></div>
                {document.requiresAcknowledgement && <StatusBadge value={document.acknowledgedAt ? "acknowledged" : "acknowledgement_required"} />}
                <div className="property-row-actions">
                  <button className="secondary-button compact" onClick={() => void openPropertyBlob(() => api.propertyDocumentBlob(document.latestVersion.id, true), document.latestVersion.filename, true, onError)}><FileText size={14} /> Preview</button>
                  <button className="secondary-button compact" onClick={() => void openPropertyBlob(() => api.propertyDocumentBlob(document.latestVersion.id), document.latestVersion.filename, false, onError)}><Download size={14} /> Download</button>
                  {document.requiresAcknowledgement && !document.acknowledgedAt && !readOnly && <button className="primary-button compact" disabled={busy} onClick={() => void run(() => api.acknowledgePropertyDocument(document.id), "Document acknowledged")}><CheckCircle2 size={14} /> Acknowledge</button>}
                  {manager && !readOnly && <label className="secondary-button compact file-action"><Upload size={14} /> New version<input type="file" accept=".pdf,.doc,.docx,.txt,image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(() => api.uploadPropertyDocumentVersion(document.id, file), "Document version uploaded"); event.currentTarget.value = ""; }} /></label>}
                </div>
              </article>
            ))}
            {platform.documents.length === 0 && <EmptyState text={manager ? "Upload leases, notices, and property records." : "No documents are shared with you yet."} />}
          </div>
        </Panel>
      )}

      {tab === "accounting" && (
        <div className="property-accounting-layout">
          <div className="property-stats compact-stats">
            <Stat icon={<Banknote size={20} />} label="Charges" value={money(platform.report.totalChargesCents)} detail="Ledger charges" />
            <Stat icon={<CheckCircle2 size={20} />} label="Payments" value={money(platform.report.totalPaymentsCents)} detail="Applied payments" tone="success" />
            <Stat icon={<ClipboardList size={20} />} label="Adjustments" value={money(platform.report.totalAdjustmentsCents)} detail="Credits and refunds" />
            <Stat icon={<ShieldCheck size={20} />} label="Balance" value={money(platform.report.outstandingCents)} detail="Current ledger balance" tone={platform.report.outstandingCents > 0 ? "warning" : "normal"} />
          </div>
          <Panel title="Recurring rent schedules" action={manager && !readOnly ? <ActionButton label="Add schedule" onClick={() => setDialog("schedule")} /> : null}>
            <div className="schedule-list">{platform.rentSchedules.map((schedule) => <article key={schedule.id}><CalendarClock size={18} /><div><strong>{schedule.propertyName}</strong><span>{money(schedule.amountCents)} · due day {schedule.dueDay}</span><small>Next charge {dateLabel(schedule.nextChargeDate)} · reminders {schedule.reminderDays.join(", ")} days</small></div><StatusBadge value={schedule.enabled ? "enabled" : "disabled"} /></article>)}{platform.rentSchedules.length === 0 && <EmptyState text="No recurring schedules configured." />}</div>
          </Panel>
          <Panel title="Ledger" action={manager ? <div className="panel-action-row"><button className="secondary-button compact" onClick={() => void api.downloadPropertyFinancialReport().catch((error) => onError(errorMessage(error)))}><Download size={14} /> Export CSV</button>{!readOnly && <ActionButton label="Adjustment" onClick={() => setDialog("adjustment")} />}</div> : null} wide>
            <div className="ledger-table">
              {platform.ledgerEntries.map((entry) => <article key={entry.id}><span>{dateLabel(entry.effectiveAt)}</span><StatusBadge value={entry.entryType} /><strong>{entry.description}</strong><em className={entry.amountCents < 0 ? "amount-paid" : "amount-due"}>{entry.amountCents < 0 ? "−" : ""}{money(Math.abs(entry.amountCents))}</em></article>)}
              {platform.ledgerEntries.length === 0 && <EmptyState text="Ledger entries appear when charges and successful payments are recorded." />}
            </div>
          </Panel>
        </div>
      )}

      {tab === "communications" && (
        <div className="property-communications-layout">
          {manager && <Panel title="Delivery integrations" action={isAdmin && !readOnly ? <button className="secondary-button compact" onClick={() => setDialog("integrations")}><Settings size={14} /> Configure</button> : null}>
              <div className="integration-summary">
                <IntegrationStatus label="Stripe webhooks" ready={platform.integrations.stripeWebhookConfigured} />
                <IntegrationStatus label="PayPal webhooks" ready={platform.integrations.paypalWebhookConfigured} />
                <IntegrationStatus label="Gmail reminders" ready={Boolean(platform.integrations.gmailConnectionId)} />
                <IntegrationStatus label="Twilio SMS" ready={platform.integrations.twilioConfigured} />
              </div>
            </Panel>}
          <Panel title="Communication consent">
            <div className="consent-list">
              {overview.tenants.map((tenant) => {
                const sms = platform.consents.find((consent) => consent.tenantId === tenant.id && consent.channel === "sms" && consent.destination === tenant.phone);
                return <article key={tenant.id}><div><strong>{tenant.displayName}</strong><span>{tenant.phone || "No phone number"}</span></div><StatusBadge value={sms?.status ?? "not_recorded"} />{tenant.phone && !readOnly && <button className="secondary-button compact" disabled={busy} onClick={() => {
                  const next = sms?.status === "opted_in" ? "opted_out" : "opted_in";
                  if (next === "opted_in" && !window.confirm(`Confirm ${tenant.displayName} explicitly consented to SMS reminders at ${tenant.phone}.`)) return;
                  void run(() => api.updatePropertyConsent({ tenantId: tenant.id, channel: "sms", destination: tenant.phone, status: next, source: next === "opted_in" ? "Manager recorded explicit tenant consent" : "Manager disabled SMS" }), `SMS ${label(next)}`);
                }}>{sms?.status === "opted_in" ? "Opt out" : "Record opt-in"}</button>}</article>;
              })}
              {overview.tenants.length === 0 && <EmptyState text="Tenant communication preferences will appear here." />}
            </div>
          </Panel>
          <Panel title="Notification jobs" action={manager && !readOnly ? <button className="secondary-button compact" disabled={busy} onClick={() => void runAutomation()}><RefreshCw className={busy ? "spin" : ""} size={14} /> Run now</button> : null} wide>
            <div className="notification-job-list">
              {platform.notificationJobs.map((job) => <article key={job.id}><span className={`notification-channel ${job.channel}`}>{label(job.channel)}</span><div><strong>{job.subject}</strong><span>{job.recipient}</span><small>Scheduled {dateTimeLabel(job.scheduledAt)} · {job.attempts} attempt{job.attempts === 1 ? "" : "s"}{job.lastError ? ` · ${job.lastError}` : ""}</small></div><StatusBadge value={job.status} /></article>)}
              {platform.notificationJobs.length === 0 && <EmptyState text="Rent reminders and delivery status will appear here." />}
            </div>
          </Panel>
          {manager && isAdmin && (
            <Panel title="Backups" action={!readOnly ? <button className="secondary-button compact" disabled={busy} onClick={() => void createBackup()}><ShieldCheck size={14} /> Create backup</button> : null} wide>
              <div className="property-backup-list">
                {backups.map((backup) => <article key={backup.id}><ShieldCheck size={18} /><div><strong>{dateTimeLabel(backup.createdAt)}</strong><span>{formatBytes(backup.sizeBytes)} · database {formatBytes(backup.databaseBytes)}</span><small>{backup.fileCount.toLocaleString()} files · retained on the server</small></div></article>)}
                {backups.length === 0 && <EmptyState text="No property backups have been created yet." />}
              </div>
            </Panel>
          )}
        </div>
      )}

      {paymentInstructions && (
        <div className="payment-instructions" role="status">
          <Banknote size={20} /><span>{paymentInstructions}</span>
          <button className="icon-button" onClick={() => setPaymentInstructions("")} aria-label="Dismiss payment instructions"><X size={17} /></button>
        </div>
      )}

      {dialog === "property" && (
        <PropertyModal title="Add property" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createProperty({
              name: data("name"), addressLine1: data("addressLine1"), addressLine2: data("addressLine2"),
              city: data("city"), state: data("state"), postalCode: data("postalCode"),
              propertyType: "single_family", status: "setup", bedrooms: nullableNumber(data("bedrooms")),
              bathrooms: nullableNumber(data("bathrooms")), monthlyRentCents: moneyInput(data("monthlyRent")), notes: data("notes")
            }), "Property added");
          }}>
            <FormGrid>
              <Field label="Property name"><input name="name" required placeholder="1299 SW 12th Ave" /></Field>
              <Field label="Street address"><input name="addressLine1" required /></Field>
              <Field label="Address line 2"><input name="addressLine2" /></Field>
              <Field label="City"><input name="city" required /></Field>
              <Field label="State"><input name="state" required defaultValue="FL" /></Field>
              <Field label="ZIP code"><input name="postalCode" required /></Field>
              <Field label="Bedrooms"><input name="bedrooms" type="number" min="0" step="1" /></Field>
              <Field label="Bathrooms"><input name="bathrooms" type="number" min="0" step="0.5" /></Field>
              <Field label="Monthly rent"><input name="monthlyRent" type="number" min="0" step="0.01" /></Field>
              <Field label="Notes" wide><textarea name="notes" rows={3} /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "unit" && (
        <PropertyModal title="Add property unit" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyUnit({
              propertyId: data("propertyId"),
              name: data("name"),
              bedrooms: nullableNumber(data("bedrooms")),
              bathrooms: nullableNumber(data("bathrooms")),
              monthlyRentCents: moneyInput(data("monthlyRent")),
              status: data("status") as "available" | "occupied" | "maintenance" | "inactive"
            }), "Unit added");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Unit name"><input name="name" required placeholder="Main unit, Apartment A, Unit 2" /></Field>
              <Field label="Bedrooms"><input name="bedrooms" type="number" min="0" step="1" /></Field>
              <Field label="Bathrooms"><input name="bathrooms" type="number" min="0" step="0.5" /></Field>
              <Field label="Monthly rent"><input name="monthlyRent" type="number" min="0" step="0.01" /></Field>
              <Field label="Status"><select name="status" defaultValue="available"><option value="available">Available</option><option value="occupied">Occupied</option><option value="maintenance">Maintenance</option><option value="inactive">Inactive</option></select></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "tenant" && (
        <PropertyModal title="Add tenant" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyTenant({
              firstName: data("firstName"), lastName: data("lastName"), email: data("email"), phone: data("phone"),
              linkedUserId: data("linkedUserId") || null, status: "active"
            }), "Tenant added");
          }}>
            <FormGrid>
              <Field label="First name"><input name="firstName" required /></Field>
              <Field label="Last name"><input name="lastName" required /></Field>
              <Field label="Email"><input name="email" type="email" required /></Field>
              <Field label="Phone"><input name="phone" type="tel" /></Field>
              {isAdmin && <Field label="Renter portal account" wide><select name="linkedUserId"><option value="">Create or invite an account later</option>{users.filter((user) => user.role === "renter" || user.role === "user").map((user) => <option key={user.id} value={user.id}>{user.displayName} ({user.username}) · {user.role}</option>)}</select><small>Renter-role accounts are restricted to the tenant portal. Existing user accounts remain available for compatibility.</small></Field>}
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "lease" && (
        <PropertyModal title="Create lease" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyLease({
              propertyId: data("propertyId"), unitId: data("unitId") || null, tenantId: data("tenantId"), startDate: data("startDate"), endDate: data("endDate"),
              monthlyRentCents: moneyInput(data("monthlyRent")) ?? 0,
              securityDepositCents: moneyInput(data("securityDeposit")) ?? 0,
              dueDay: Number(data("dueDay") || 1), status: "active"
            }), "Lease created");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Unit"><select name="unitId"><option value="">Default unit</option>{platform.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.propertyName} · {unit.name}</option>)}</select></Field>
              <Field label="Tenant"><select name="tenantId" required><option value="">Choose tenant</option>{overview.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.displayName}</option>)}</select></Field>
              <Field label="Start date"><input name="startDate" type="date" required /></Field>
              <Field label="End date"><input name="endDate" type="date" required /></Field>
              <Field label="Monthly rent"><input name="monthlyRent" type="number" min="0.01" step="0.01" required /></Field>
              <Field label="Security deposit"><input name="securityDeposit" type="number" min="0" step="0.01" defaultValue="0" /></Field>
              <Field label="Rent due day"><input name="dueDay" type="number" min="1" max="28" defaultValue="1" required /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "request" && (
        <PropertyModal title="New service request" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyServiceRequest({
              propertyId: data("propertyId"), tenantId: data("tenantId") || null, title: data("title"),
              description: data("description"), category: data("category") || "General",
              priority: data("priority") as "low" | "normal" | "high" | "urgent", preferredEntryAt: null
            }), "Service request created");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              {manager && <Field label="Tenant"><select name="tenantId"><option value="">No tenant selected</option>{overview.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.displayName}</option>)}</select></Field>}
              <Field label="Title" wide><input name="title" required placeholder="Air conditioner is not cooling" /></Field>
              <Field label="Category"><select name="category" defaultValue="General"><option>General</option><option>Plumbing</option><option>Electrical</option><option>HVAC</option><option>Appliance</option><option>Safety</option><option>Exterior</option></select></Field>
              <Field label="Priority"><select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field>
              <Field label="Description" wide><textarea name="description" required rows={5} /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "charge" && (
        <PropertyModal title="Add rent charge" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyRentCharge({
              propertyId: data("propertyId"), leaseId: data("leaseId") || null,
              description: data("description"), amountCents: moneyInput(data("amount")) ?? 0, dueDate: data("dueDate")
            }), "Rent charge added");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Lease"><select name="leaseId"><option value="">No lease</option>{activeLeases.map((lease) => <option key={lease.id} value={lease.id}>{lease.propertyName} · {lease.tenantName}</option>)}</select></Field>
              <Field label="Description" wide><input name="description" required placeholder="August 2026 rent" /></Field>
              <Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required /></Field>
              <Field label="Due date"><input name="dueDate" type="date" required /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "payment" && (
        <PropertyModal title={manager ? "Record or start payment" : "Pay rent or fee"} busy={busy} onClose={() => { setDialog(null); setPaymentChargeId(null); }}>
          <form onSubmit={async (event) => {
            event.preventDefault();
            const data = formData(event);
            const provider = data("provider") as PropertyPaymentProvider;
            const method = defaultMethod(provider);
            setBusy(true);
            try {
              const payment = await api.createPropertyPayment({
                propertyId: data("propertyId"), leaseId: data("leaseId") || null, chargeId: data("chargeId") || null,
                provider, method, amountCents: moneyInput(data("amount")) ?? 0, currency: "USD", status: "pending",
                reference: data("reference") || null, paidAt: null, notes: data("notes")
              });
              const checkout = await api.createPropertyPaymentCheckout(payment.id);
              setDialog(null);
              setPaymentChargeId(null);
              if (checkout.action === "redirect" && checkout.url) { window.location.assign(checkout.url); return; }
              if (checkout.instructions) setPaymentInstructions(checkout.instructions);
              onNotice(checkout.action === "redirect" ? "Secure payment checkout opened" : "Payment instructions created");
              await load();
            } catch (error) {
              onError(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" defaultValue={paymentCharge?.propertyId} /></Field>
              <Field label="Lease"><select name="leaseId" defaultValue={paymentCharge?.leaseId ?? ""}><option value="">No lease</option>{activeLeases.map((lease) => <option key={lease.id} value={lease.id}>{lease.propertyName} · {lease.tenantName}</option>)}</select></Field>
              <Field label="Apply to charge"><select name="chargeId" defaultValue={paymentCharge?.id ?? ""}><option value="">Unallocated payment</option>{overview.rentCharges.filter((charge) => charge.balanceCents > 0).map((charge) => <option key={charge.id} value={charge.id}>{charge.propertyName} · {charge.description} · {money(charge.balanceCents)}</option>)}</select></Field>
              <Field label="Payment method"><select name="provider" required defaultValue={firstConfiguredProvider(overview)}>{providerOptions(overview).map((option) => <option key={option.value} value={option.value} disabled={!option.configured}>{option.label}{option.configured ? "" : " — not configured"}</option>)}</select></Field>
              <Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" defaultValue={paymentCharge ? (paymentCharge.balanceCents / 100).toFixed(2) : ""} required /></Field>
              <Field label="Reference"><input name="reference" placeholder="Optional check or Zelle reference" /></Field>
              <Field label="Notes" wide><textarea name="notes" rows={3} /></Field>
            </FormGrid>
            <div className="payment-safety-note"><ShieldCheck size={17} /><span>Card, Apple Pay, Google Pay, ACH, and PayPal credentials stay with the payment provider. This app stores only status, amount, provider IDs, and timestamps.</span></div>
            <ModalActions busy={busy} submitLabel="Continue" />
          </form>
        </PropertyModal>
      )}

      {dialog === "document" && (
        <PropertyModal title="Upload property document" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const file = data.get("file");
            if (!(file instanceof File) || file.size === 0) return onError("Choose a document file");
            void run(() => api.uploadPropertyDocument({
              propertyId: String(data.get("propertyId") ?? ""),
              leaseId: String(data.get("leaseId") ?? "") || null,
              tenantId: String(data.get("tenantId") ?? "") || null,
              title: String(data.get("title") ?? "").trim(),
              category: String(data.get("category") ?? "Agreement"),
              visibility: String(data.get("visibility") ?? "tenant") as "manager" | "tenant",
              requiresAcknowledgement: data.get("requiresAcknowledgement") === "on"
            }, file), "Document uploaded");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Lease"><select name="leaseId"><option value="">Entire property</option>{overview.leases.map((lease) => <option key={lease.id} value={lease.id}>{lease.propertyName} · {lease.tenantName}</option>)}</select></Field>
              <Field label="Tenant"><select name="tenantId"><option value="">All assigned tenants</option>{overview.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.displayName}</option>)}</select></Field>
              <Field label="Category"><select name="category" defaultValue="Agreement"><option>Agreement</option><option>Notice</option><option>Inspection</option><option>Insurance</option><option>Receipt</option><option>Other</option></select></Field>
              <Field label="Title" wide><input name="title" required placeholder="Signed rental agreement" /></Field>
              <Field label="Visibility"><select name="visibility" defaultValue="tenant"><option value="tenant">Share with tenant</option><option value="manager">Managers only</option></select></Field>
              <Field label="File"><input name="file" type="file" required accept=".pdf,.doc,.docx,.txt,image/jpeg,image/png,image/webp" /></Field>
              <Field label="Acknowledgement" wide><span className="checkbox-field"><input name="requiresAcknowledgement" type="checkbox" /> Require tenant acknowledgement</span></Field>
            </FormGrid>
            <ModalActions busy={busy} submitLabel="Upload" />
          </form>
        </PropertyModal>
      )}

      {dialog === "schedule" && (
        <PropertyModal title="Create recurring rent schedule" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyRentSchedule({
              propertyId: data("propertyId"), leaseId: data("leaseId"),
              amountCents: moneyInput(data("amount")) ?? 0, dueDay: Number(data("dueDay")),
              descriptionTemplate: data("descriptionTemplate"), nextChargeDate: data("nextChargeDate"),
              reminderDays: data("reminderDays").split(",").map(Number).filter(Number.isFinite), enabled: true
            }), "Rent schedule created");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Lease"><select name="leaseId" required><option value="">Choose lease</option>{activeLeases.map((lease) => <option key={lease.id} value={lease.id}>{lease.propertyName} · {lease.tenantName}</option>)}</select></Field>
              <Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required /></Field>
              <Field label="Due day"><input name="dueDay" type="number" min="1" max="28" defaultValue="1" required /></Field>
              <Field label="Next charge date"><input name="nextChargeDate" type="date" required /></Field>
              <Field label="Reminder offsets"><input name="reminderDays" defaultValue="-7,-3,0,3" required /><small>Comma-separated days relative to due date.</small></Field>
              <Field label="Description" wide><input name="descriptionTemplate" defaultValue="{{month}} rent" required /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "adjustment" && (
        <PropertyModal title="Add ledger adjustment" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.createPropertyLedgerAdjustment({
              propertyId: data("propertyId"), leaseId: data("leaseId") || null, chargeId: data("chargeId") || null,
              amountCents: Math.round(Number(data("amount")) * 100), description: data("description"),
              effectiveAt: new Date(`${data("effectiveDate")}T12:00:00`).toISOString()
            }), "Ledger adjustment added");
          }}>
            <FormGrid>
              <Field label="Property"><PropertySelect properties={overview.properties} name="propertyId" /></Field>
              <Field label="Lease"><select name="leaseId"><option value="">No lease</option>{overview.leases.map((lease) => <option key={lease.id} value={lease.id}>{lease.propertyName} · {lease.tenantName}</option>)}</select></Field>
              <Field label="Charge"><select name="chargeId"><option value="">No charge</option>{overview.rentCharges.map((charge) => <option key={charge.id} value={charge.id}>{charge.propertyName} · {charge.description}</option>)}</select></Field>
              <Field label="Amount"><input name="amount" type="number" step="0.01" required /><small>Positive adds a balance; negative creates a credit.</small></Field>
              <Field label="Effective date"><input name="effectiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></Field>
              <Field label="Description" wide><input name="description" required placeholder="Late fee, concession, or account credit" /></Field>
            </FormGrid>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}

      {dialog === "integrations" && (
        <PropertyModal title="Property integrations" busy={busy} onClose={() => setDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            void run(() => api.updatePropertyIntegrations({
              clearStripeSecretKey: false,
              clearStripeWebhookSecret: false,
              clearPaypalClientSecret: false,
              clearTwilioAuthToken: false,
              ...(data("stripeSecretKey") ? { stripeSecretKey: data("stripeSecretKey") } : {}),
              ...(data("stripeWebhookSecret") ? { stripeWebhookSecret: data("stripeWebhookSecret") } : {}),
              ...(data("paypalClientId") ? { paypalClientId: data("paypalClientId") } : {}),
              ...(data("paypalClientSecret") ? { paypalClientSecret: data("paypalClientSecret") } : {}),
              ...(data("paypalWebhookId") ? { paypalWebhookId: data("paypalWebhookId") } : {}),
              paypalEnvironment: data("paypalEnvironment") as "sandbox" | "live",
              zelleRecipient: data("zelleRecipient") || null,
              zelleNote: data("zelleNote"),
              appleCashRecipient: data("appleCashRecipient") || null,
              appleCashNote: data("appleCashNote"),
              ...(data("twilioAccountSid") ? { twilioAccountSid: data("twilioAccountSid") } : {}),
              ...(data("twilioAuthToken") ? { twilioAuthToken: data("twilioAuthToken") } : {}),
              ...(data("twilioMessagingServiceSid") ? { twilioMessagingServiceSid: data("twilioMessagingServiceSid") } : {}),
              gmailConnectionId: data("gmailConnectionId") || null
            }), "Property integrations updated");
          }}>
            <FormGrid>
              <Field label="Stripe secret key"><input name="stripeSecretKey" type="password" placeholder={platform.integrations.stripeConfigured ? "Configured — leave blank to keep" : "sk_…"} /></Field>
              <Field label="Stripe webhook secret"><input name="stripeWebhookSecret" type="password" placeholder={platform.integrations.stripeWebhookConfigured ? "Configured — leave blank to keep" : "whsec_…"} /></Field>
              <Field label="PayPal client ID"><input name="paypalClientId" placeholder={platform.integrations.paypalConfigured ? "Configured — leave blank to keep" : "Client ID"} /></Field>
              <Field label="PayPal secret"><input name="paypalClientSecret" type="password" placeholder={platform.integrations.paypalConfigured ? "Configured — leave blank to keep" : "Secret"} /></Field>
              <Field label="PayPal webhook ID"><input name="paypalWebhookId" placeholder={platform.integrations.paypalWebhookConfigured ? "Configured — leave blank to keep" : "Webhook ID"} /></Field>
              <Field label="PayPal environment"><select name="paypalEnvironment" defaultValue={platform.integrations.paypalEnvironment}><option value="sandbox">Sandbox</option><option value="live">Live</option></select></Field>
              <Field label="Zelle recipient" wide><input name="zelleRecipient" defaultValue={platform.integrations.zelleRecipient ?? ""} placeholder="Email address or mobile number registered with Zelle" /></Field>
              <Field label="Zelle instructions"><input name="zelleNote" defaultValue="Include the property address and payment reference in the memo." /></Field>
              <Field label="Apple Cash recipient" wide><input name="appleCashRecipient" defaultValue={platform.integrations.appleCashRecipient ?? ""} placeholder="Mobile number (or Apple ID email) that receives Apple Cash" /></Field>
              <Field label="Apple Cash instructions" wide><input name="appleCashNote" defaultValue={platform.integrations.appleCashNote ?? ""} placeholder="Apple Cash is sent from Messages and must be confirmed manually — it cannot be verified automatically." /></Field>
              <Field label="Twilio Account SID"><input name="twilioAccountSid" placeholder={platform.integrations.twilioConfigured ? "Configured — leave blank to keep" : "AC…"} /></Field>
              <Field label="Twilio auth token"><input name="twilioAuthToken" type="password" placeholder={platform.integrations.twilioConfigured ? "Configured — leave blank to keep" : "Auth token"} /></Field>
              <Field label="Twilio Messaging Service SID"><input name="twilioMessagingServiceSid" placeholder="MG…" /></Field>
              <Field label="Gmail reminder account"><select name="gmailConnectionId" defaultValue={platform.integrations.gmailConnectionId ?? ""}><option value="">Disabled</option>{gmailConnections.filter((connection) => connection.canSend).map((connection) => <option key={connection.id} value={connection.id}>{connection.email}</option>)}</select></Field>
            </FormGrid>
            <div className="payment-safety-note"><ShieldCheck size={17} /><span>Saved secrets are stored in the local data directory with owner-only file permissions. Environment variables remain supported as a fallback.</span></div>
            <ModalActions busy={busy} />
          </form>
        </PropertyModal>
      )}
    </section>
  );
}

function Panel({ title, action, children, wide = false }: { title: string; action?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section className={`property-panel ${wide ? "wide" : ""}`}><header><h2>{title}</h2>{action}</header>{children}</section>;
}

function Stat({ icon, label: text, value, detail, tone = "normal" }: { icon: ReactNode; label: string; value: string; detail: string; tone?: "normal" | "warning" | "success" }) {
  return <article className={`property-stat ${tone}`}><span className="property-stat-icon">{icon}</span><div><small>{text}</small><strong>{value}</strong><span>{detail}</span></div></article>;
}

function PropertyTabButton({ active, onClick, icon, label: text, count }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; count?: number }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{text}</span>{count ? <small>{count}</small> : null}</button>;
}

function ActionButton({ label: text, onClick }: { label: string; onClick: () => void }) {
  return <button className="secondary-button compact" onClick={onClick}><Plus size={15} /> {text}</button>;
}

function PropertyCards({ properties, photoUrls, compact = false, onPhoto }: { properties: ManagedProperty[]; photoUrls: Record<string, string>; compact?: boolean; onPhoto?: (property: ManagedProperty, file: File) => Promise<void> }) {
  if (properties.length === 0) return <EmptyState text="No properties yet." />;
  return <div className={`property-cards ${compact ? "compact" : ""}`}>{properties.map((property) => (
    <article className="property-card" key={property.id}>
      <div className="property-photo">
        {photoUrls[property.id] ? <img src={photoUrls[property.id]} alt={property.name} /> : <span><Building2 size={30} /></span>}
        {onPhoto && <label className="photo-upload"><Camera size={15} /><span>Photo</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onPhoto(property, file); event.currentTarget.value = ""; }} /></label>}
      </div>
      <div className="property-card-body">
        <div><h3>{property.name}</h3><StatusBadge value={property.status} /></div>
        <p>{property.addressLine1}{property.addressLine2 ? `, ${property.addressLine2}` : ""}<br />{property.city}, {property.state} {property.postalCode}</p>
        <dl>
          <div><dt>Tenant</dt><dd>{property.tenantName ?? "Not assigned"}</dd></div>
          <div><dt>Monthly rent</dt><dd>{property.monthlyRentCents === null ? "Not set" : money(property.monthlyRentCents)}</dd></div>
          <div><dt>Open requests</dt><dd>{property.openRequestCount}</dd></div>
          <div><dt>Balance</dt><dd className={property.outstandingBalanceCents > 0 ? "amount-due" : ""}>{money(property.outstandingBalanceCents)}</dd></div>
        </dl>
      </div>
    </article>
  ))}</div>;
}

function RequestList({ requests }: { requests: PropertyPortfolioOverview["serviceRequests"] }) {
  if (requests.length === 0) return <EmptyState text="No service requests." />;
  return <div className="request-list">{requests.map((request) => <div key={request.id}><span className={`request-dot ${request.priority}`} /><span><strong>{request.title}</strong><small>{request.propertyName} · {label(request.status)}</small></span><time>{dateLabel(request.createdAt)}</time></div>)}</div>;
}

function ProviderGrid({ overview, detailed = false }: { overview: PropertyPortfolioOverview; detailed?: boolean }) {
  const providers = [
    { name: "Stripe", detail: "Cards, Apple Pay, Google Pay, and ACH", configured: overview.paymentConfiguration.stripe.configured },
    { name: "PayPal", detail: `PayPal Checkout · ${overview.paymentConfiguration.paypal.environment}`, configured: overview.paymentConfiguration.paypal.configured },
    { name: "Zelle", detail: overview.paymentConfiguration.zelle.recipient ? `Tenants send to ${overview.paymentConfiguration.zelle.recipient} · confirmed manually` : "Add a Zelle recipient in Communications > Configure", configured: overview.paymentConfiguration.zelle.configured },
    { name: "Apple Cash", detail: overview.paymentConfiguration.appleCash.recipient ? `Tenants send to ${overview.paymentConfiguration.appleCash.recipient} in Messages · confirmed manually` : "Add an Apple Cash recipient in Communications > Configure", configured: overview.paymentConfiguration.appleCash.configured },
    { name: "Manual", detail: "Cash, check, and other verified offline receipts", configured: true }
  ];
  return <div className={`provider-grid ${detailed ? "detailed" : ""}`}>{providers.map((provider) => <article key={provider.name}><span className={provider.configured ? "configured" : "unconfigured"}>{provider.configured ? <CheckCircle2 size={17} /> : <X size={17} />}</span><div><strong>{provider.name}</strong><small>{provider.detail}</small></div><em>{provider.configured ? "Ready" : "Not configured"}</em></article>)}</div>;
}

const INSTRUCTION_PROVIDERS: PropertyPaymentProvider[] = ["zelle", "apple_cash", "manual"];

/** Where an out-of-band payment should be sent, and how the manager will recognise it. */
function instructionTarget(
  provider: PropertyPaymentProvider,
  configuration: PropertyPaymentConfiguration
): { title: string; recipientLabel: string; recipient: string | null; note: string; how: string } {
  if (provider === "apple_cash") return {
    title: "Apple Cash",
    recipientLabel: "Send to",
    recipient: configuration.appleCash.recipient,
    note: configuration.appleCash.note,
    how: "Open Messages on your iPhone or iPad, start a conversation with this number, tap Apple Cash, enter the amount, and include the reference in the message."
  };
  if (provider === "zelle") return {
    title: "Zelle",
    recipientLabel: "Send to",
    recipient: configuration.zelle.recipient,
    note: configuration.zelle.note,
    how: "Open your bank's app, choose Zelle, send to this recipient, and put the reference in the memo."
  };
  return {
    title: "Cash, check or bank transfer",
    recipientLabel: "Hand to",
    recipient: null,
    note: "",
    how: "Arrange delivery with your property manager and quote the reference so the payment can be matched."
  };
}

export function PaymentInstructionList({ payments, configuration, onCopied }: {
  payments: PropertyPayment[];
  configuration: PropertyPaymentConfiguration;
  onCopied: (what: string) => void;
}) {
  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied(what);
    } catch {
      // Clipboard access can be denied; the value is on screen either way.
    }
  };
  return (
    <div className="payment-instructions">
      {payments.map((payment) => {
        const target = instructionTarget(payment.provider, configuration);
        return (
          <article key={payment.id} className="payment-instruction">
            <header>
              <div>
                <strong>{money(payment.amountCents)}</strong>
                <small>{target.title} · {payment.propertyName}</small>
              </div>
              <StatusBadge value={payment.status} />
            </header>
            <dl>
              {target.recipient ? (
                <div>
                  <dt>{target.recipientLabel}</dt>
                  <dd>
                    <code>{target.recipient}</code>
                    <button
                      className="secondary-button compact"
                      onClick={() => void copy(target.recipient!, "Recipient")}
                      aria-label={`Copy ${target.title} recipient`}
                    >
                      <Copy size={13} /> Copy
                    </button>
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>{target.recipientLabel}</dt>
                  <dd><span className="payment-instruction-missing">Ask your property manager where to send this payment.</span></dd>
                </div>
              )}
              {payment.reference && (
                <div>
                  <dt>Reference</dt>
                  <dd>
                    <code>{payment.reference}</code>
                    <button
                      className="secondary-button compact"
                      onClick={() => void copy(payment.reference!, "Reference")}
                      aria-label="Copy payment reference"
                    >
                      <Copy size={13} /> Copy
                    </button>
                  </dd>
                </div>
              )}
            </dl>
            <p className="payment-instruction-how">{target.how}</p>
            {target.note && <p className="payment-instruction-note">{target.note}</p>}
            <footer>Your manager marks this paid once the money arrives — {target.title} cannot confirm it automatically.</footer>
          </article>
        );
      })}
    </div>
  );
}

function PaymentHistory({ payments, manager, busy, onSync, onMarkPaid, onRefund }: { payments: PropertyPayment[]; manager: boolean; busy: boolean; onSync: (payment: PropertyPayment) => void; onMarkPaid: (payment: PropertyPayment) => void; onRefund: (payment: PropertyPayment) => void }) {
  if (payments.length === 0) return <EmptyState text="No payment history." />;
  return <div className="payment-history">{payments.map((payment) => <article key={payment.id}><div><strong>{money(payment.amountCents)}</strong><span>{payment.propertyName} · {label(payment.provider)} / {label(payment.method)}</span><small>{payment.paidAt ? `Paid ${dateTimeLabel(payment.paidAt)}` : `Created ${dateTimeLabel(payment.createdAt)}`}{payment.reference ? ` · ${payment.reference}` : ""}</small></div><StatusBadge value={payment.status} /><div className="payment-row-actions">{["stripe", "paypal"].includes(payment.provider) && !["succeeded", "refunded", "cancelled"].includes(payment.status) && <button className="secondary-button compact" disabled={busy} onClick={() => onSync(payment)}><RefreshCw size={14} /> Sync</button>}{manager && ["zelle", "manual"].includes(payment.provider) && payment.status !== "succeeded" && <button className="secondary-button compact" disabled={busy} onClick={() => onMarkPaid(payment)}><CheckCircle2 size={14} /> Mark paid</button>}{manager && payment.status === "succeeded" && <button className="secondary-button compact danger" disabled={busy} onClick={() => onRefund(payment)}>Refund</button>}</div></article>)}</div>;
}

function PropertyModal({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  return <div className="property-modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><section className="property-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">Property management</span><h2>{title}</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X size={19} /></button></header>{children}</section></div>;
}

function FormGrid({ children }: { children: ReactNode }) { return <div className="property-form-grid">{children}</div>; }
function Field({ label: text, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { return <label className={wide ? "wide" : ""}><span>{text}</span>{children}</label>; }
function ModalActions({ busy, submitLabel = "Save" }: { busy: boolean; submitLabel?: string }) { return <footer className="property-modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <CheckCircle2 size={17} />}{busy ? "Saving…" : submitLabel}</button></footer>; }
function PropertySelect({ properties, name, defaultValue }: { properties: ManagedProperty[]; name: string; defaultValue?: string }) { return <select name={name} defaultValue={defaultValue ?? ""} required><option value="">Choose property</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select>; }
function StatusBadge({ value }: { value: string }) { return <span className={`property-status ${value}`}>{label(value)}</span>; }
function EmptyState({ text }: { text: string }) { return <div className="property-empty"><ClipboardList size={21} /><span>{text}</span></div>; }
function IntegrationStatus({ label: text, ready }: { label: string; ready: boolean }) { return <div><span className={ready ? "configured" : "unconfigured"}>{ready ? <CheckCircle2 size={16} /> : <X size={16} />}</span><strong>{text}</strong><small>{ready ? "Ready" : "Not configured"}</small></div>; }

function formData(event: FormEvent<HTMLFormElement>): (name: string) => string {
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? "").trim();
}

function nullableNumber(value: string): number | null { return value === "" ? null : Number(value); }
function moneyInput(value: string): number | null { return value === "" ? null : Math.round(Number(value) * 100); }
function money(cents: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function dateLabel(value: string): string { const date = new Date(value.includes("T") ? value : `${value}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function dateTimeLabel(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date); }
function label(value: string): string { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function initials(value: string): string { return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join(""); }
function defaultMethod(provider: PropertyPaymentProvider): PropertyPaymentMethod { if (provider === "stripe") return "card"; if (provider === "paypal") return "paypal"; if (provider === "zelle") return "zelle"; return "other"; }
function providerOptions(overview: PropertyPortfolioOverview): Array<{ value: PropertyPaymentProvider; label: string; configured: boolean }> { return [
  { value: "stripe", label: "Card, Apple Pay or Google Pay (Stripe)", configured: overview.paymentConfiguration.stripe.configured },
  { value: "paypal", label: "PayPal", configured: overview.paymentConfiguration.paypal.configured },
  { value: "zelle", label: "Zelle", configured: overview.paymentConfiguration.zelle.configured },
  { value: "apple_cash", label: "Apple Cash (send in Messages)", configured: overview.paymentConfiguration.appleCash.configured },
  { value: "manual", label: "Cash / check / other", configured: true }
]; }
function firstConfiguredProvider(overview: PropertyPortfolioOverview): PropertyPaymentProvider { return providerOptions(overview).find((option) => option.configured)?.value ?? "manual"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? "Property request failed"); }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
async function openPropertyBlob(load: () => Promise<Blob>, filename: string, preview: boolean, onError: (message: string) => void): Promise<void> {
  try {
    const url = URL.createObjectURL(await load());
    if (preview) window.open(url, "_blank", "noopener,noreferrer");
    else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    onError(errorMessage(error));
  }
}
