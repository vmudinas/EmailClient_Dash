import type { PropertyAutomationRunResult, PropertyPayment } from "@email-client/shared";
import type { GmailService } from "./gmail-service.js";
import type { PropertyIntegrationSettingsManager } from "./property-integration-settings.js";
import type { PropertyPaymentService } from "./property-payment-service.js";
import type { PropertyPlatformStore } from "../storage/property-platform-store.js";
import type { PropertyStore } from "../storage/property-store.js";

export class PropertyAutomationService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running: Promise<PropertyAutomationRunResult> | null = null;
  private closed = false;

  constructor(
    private readonly properties: PropertyStore,
    private readonly platform: PropertyPlatformStore,
    private readonly payments: PropertyPaymentService,
    private readonly gmail: GmailService,
    private readonly integrations: PropertyIntegrationSettingsManager,
    private readonly intervalMinutes: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  start(): void {
    if (this.intervalMinutes <= 0 || this.timer) return;
    this.closed = false;
    this.timer = setInterval(() => void this.runNow(), this.intervalMinutes * 60_000);
    this.timer.unref();
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (!this.closed) void this.runNow();
    }, 1_000);
    this.initialTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
    await this.running?.catch(() => undefined);
  }

  runNow(): Promise<PropertyAutomationRunResult> {
    if (this.closed) return Promise.resolve(emptyRunResult());
    if (this.running) {
      const now = new Date().toISOString();
      return Promise.resolve({
        startedAt: now,
        completedAt: now,
        chargesCreated: 0,
        providerEventsProcessed: 0,
        notificationsCompleted: 0,
        notificationsFailed: 0,
        alreadyRunning: true
      });
    }
    this.running = this.execute().finally(() => { this.running = null; });
    return this.running;
  }

  private async execute(): Promise<PropertyAutomationRunResult> {
    const startedAt = new Date().toISOString();
    let chargesCreated = 0;
    let providerEventsProcessed = 0;
    let notificationsCompleted = 0;
    let notificationsFailed = 0;
    const today = startedAt.slice(0, 10);

    for (const schedule of this.platform.dueRentSchedules(today)) {
      if (!this.platform.claimRentScheduleRun(schedule.id, schedule.nextChargeDate)) continue;
      try {
        const ownerUserId = this.platform.rentScheduleOwnerUserId(schedule.id);
        const charge = this.properties.createRentCharge(ownerUserId, {
          propertyId: schedule.propertyId,
          leaseId: schedule.leaseId,
          description: schedule.descriptionTemplate.replace("{{month}}", monthLabel(schedule.nextChargeDate)),
          amountCents: schedule.amountCents,
          dueDate: schedule.nextChargeDate
        });
        this.platform.recordCharge(ownerUserId, charge);
        this.platform.enqueueChargeReminders(charge.id, schedule.reminderDays);
        this.platform.completeRentScheduleRun(schedule.id, schedule.nextChargeDate, charge.id);
        chargesCreated += 1;
      } catch (error) {
        this.platform.failRentScheduleRun(schedule.id, schedule.nextChargeDate, errorMessage(error));
      }
    }

    for (let processed = 0; processed < 100; processed += 1) {
      const event = this.platform.claimProviderEvent();
      if (!event) break;
      try {
        const payment = this.payments.applyProviderEvent(event.provider, event.eventType, event.payload);
        if (payment?.status === "succeeded") this.platform.recordSuccessfulPayment(payment);
        const refund = providerRefund(event.provider, event.eventType, event.payload, payment, event.eventId);
        if (payment && refund.amountCents > 0) {
          this.platform.recordRefund(payment.id, refund.amountCents, `${event.provider} refund`, refund.id);
        }
        this.platform.completeProviderEvent(event.id);
        providerEventsProcessed += 1;
      } catch (error) {
        this.platform.failProviderEvent(event.id, errorMessage(error), event.attempts < 5);
      }
    }

    for (let processed = 0; processed < 100; processed += 1) {
      const job = this.platform.claimNotificationJob(new Date().toISOString());
      if (!job) break;
      try {
        if (job.channel === "in_app") {
          this.platform.completeNotificationJob(job.id, "local", null, "succeeded");
        } else if (job.channel === "email") {
          const connectionId = this.integrations.current().gmailConnectionId;
          if (!connectionId) throw new Error("Gmail reminder account is not configured");
          const sent = await this.gmail.sendMessage(connectionId, {
            to: [job.recipient], cc: [], bcc: [], subject: job.subject, bodyText: job.body
          });
          this.platform.completeNotificationJob(job.id, "gmail", sent.id, "succeeded");
        } else if (!this.platform.canSendSms(job.tenantId, job.recipient)) {
          this.platform.completeNotificationJob(job.id, "consent", null, "suppressed", "SMS consent is not active");
        } else {
          const messageId = await this.sendSms(job.recipient, job.body);
          this.platform.completeNotificationJob(job.id, "twilio", messageId, "succeeded");
        }
        notificationsCompleted += 1;
      } catch (error) {
        this.platform.failNotificationJob(job.id, errorMessage(error));
        notificationsFailed += 1;
      }
    }

    return {
      startedAt,
      completedAt: new Date().toISOString(),
      chargesCreated,
      providerEventsProcessed,
      notificationsCompleted,
      notificationsFailed,
      alreadyRunning: false
    };
  }

  private async sendSms(recipient: string, body: string): Promise<string> {
    const settings = this.integrations.current();
    if (!settings.twilioAccountSid || !settings.twilioAuthToken || !settings.twilioMessagingServiceSid) {
      throw new Error("Twilio SMS is not configured");
    }
    const response = await this.fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.twilioAccountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${settings.twilioAccountSid}:${settings.twilioAuthToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ To: recipient, MessagingServiceSid: settings.twilioMessagingServiceSid, Body: body })
      }
    );
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : `Twilio SMS failed (${response.status})`);
    if (typeof payload.sid !== "string") throw new Error("Twilio did not return a message ID");
    return payload.sid;
  }
}

function emptyRunResult(): PropertyAutomationRunResult {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    chargesCreated: 0,
    providerEventsProcessed: 0,
    notificationsCompleted: 0,
    notificationsFailed: 0,
    alreadyRunning: false
  };
}

function monthLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00.000Z`));
}

function providerRefund(
  provider: "stripe" | "paypal",
  eventType: string,
  payload: Record<string, unknown>,
  payment: PropertyPayment | null,
  fallbackId: string
): { amountCents: number; id: string } {
  const lowerEventType = eventType.toLowerCase();
  if (!payment || (!lowerEventType.includes("refund") && !lowerEventType.includes("reversed"))) {
    return { amountCents: 0, id: fallbackId };
  }
  const resource = provider === "stripe"
    ? objectValue(objectValue(payload.data)?.object)
    : objectValue(payload.resource);
  if (!resource) return { amountCents: 0, id: fallbackId };
  if (provider === "stripe") {
    const refunds = objectValue(resource.refunds);
    const refundRows = Array.isArray(refunds?.data) ? refunds.data : [];
    const latestRefund = objectValue(refundRows[0]);
    return {
      amountCents: Number(latestRefund?.amount ?? resource.amount_refunded ?? resource.amount ?? payment.amountCents),
      id: typeof latestRefund?.id === "string" ? latestRefund.id : fallbackId
    };
  }
  const amount = objectValue(resource.amount);
  const value = Number(amount?.value ?? 0);
  return {
    amountCents: Number.isFinite(value) && value > 0 ? Math.round(value * 100) : payment.amountCents,
    id: typeof resource.id === "string" ? resource.id : fallbackId
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Property automation failed");
}
