import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";
import type {
  PropertyCommunicationConsent,
  PropertyDeliveryAttempt,
  PropertyDocument,
  PropertyDocumentMetadata,
  PropertyDocumentVersion,
  PropertyIntegrationSettings,
  PropertyInvitationPreview,
  PropertyLedgerAdjustment,
  PropertyLedgerEntry,
  PropertyNotificationChannel,
  PropertyNotificationJob,
  PropertyOperationsReport,
  PropertyOrganization,
  PropertyOrganizationMember,
  PropertyPlatformOverview,
  PropertyReceipt,
  PropertyRentSchedule,
  PropertyRentScheduleCreate,
  PropertyRequestAttachment,
  PropertyRequestComment,
  PropertyRequestStatusEvent,
  PropertyServiceRequestStatus,
  PropertyTenantInvitation,
  PropertyUnit,
  PropertyUnitCreate
} from "@email-client/shared";
import type { StoredPropertyFile } from "../services/property-file-service.js";

type Row = Record<string, unknown>;

export interface ClaimedProviderEvent {
  id: string;
  provider: "stripe" | "paypal";
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface ClaimedNotificationJob extends PropertyNotificationJob {
  idempotencyKey: string;
}

export class PropertyPlatformNotFoundError extends Error {}
export class PropertyPlatformAccessError extends Error {}
export class PropertyInvitationError extends Error {}

export class PropertyPlatformStore {
  private readonly db: SqliteDatabase;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new BetterSqlite3(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 30000");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  isManager(userId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM property_organizations o
      LEFT JOIN property_organization_members m ON m.organization_id = o.id
      WHERE o.owner_user_id = ? OR (m.user_id = ? AND m.role IN ('owner', 'manager'))
      LIMIT 1
    `).get(userId, userId));
  }

  assertManager(userId: string): void {
    if (!this.isManager(userId)) throw new PropertyPlatformAccessError("Property manager access required");
  }

  ensureDefaultOrganization(ownerUserId: string, name = "Vitas Property Management"): PropertyOrganization {
    let row = this.db.prepare("SELECT * FROM property_organizations WHERE owner_user_id = ? ORDER BY created_at LIMIT 1")
      .get(ownerUserId) as Row | undefined;
    if (!row) {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO property_organizations (id, owner_user_id, name, timezone, created_at, updated_at)
        VALUES (?, ?, ?, 'America/New_York', ?, ?)
      `).run(id, ownerUserId, name, now, now);
      this.db.prepare(`
        INSERT OR IGNORE INTO property_organization_members
          (id, organization_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(randomUUID(), id, ownerUserId, now);
      row = this.db.prepare("SELECT * FROM property_organizations WHERE id = ?").get(id) as Row;
    }
    const organization = mapOrganization(row);
    this.db.prepare(`
      UPDATE managed_properties SET organization_id = ?
      WHERE owner_user_id = ? AND (organization_id IS NULL OR organization_id = '')
    `).run(organization.id, ownerUserId);
    this.ensureUnits(ownerUserId, organization.id);
    return organization;
  }

  createOrganization(ownerUserId: string, name: string, timezone: string): PropertyOrganization {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO property_organizations (id, owner_user_id, name, timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, ownerUserId, name, timezone, now, now);
      this.db.prepare(`
        INSERT INTO property_organization_members (id, organization_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(randomUUID(), id, ownerUserId, now);
    })();
    return this.requireOrganization(ownerUserId, id);
  }

  syncProperty(ownerUserId: string, propertyId: string): PropertyUnit {
    const organization = this.ensureDefaultOrganization(ownerUserId);
    const property = this.db.prepare("SELECT * FROM managed_properties WHERE id = ? AND owner_user_id = ?")
      .get(propertyId, ownerUserId) as Row | undefined;
    if (!property) throw new PropertyPlatformNotFoundError("Property not found");
    this.db.prepare("UPDATE managed_properties SET organization_id = ? WHERE id = ?")
      .run(organization.id, propertyId);
    let unit = this.db.prepare("SELECT * FROM property_units WHERE property_id = ? ORDER BY created_at LIMIT 1")
      .get(propertyId) as Row | undefined;
    if (!unit) {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO property_units (
          id, organization_id, property_id, name, bedrooms, bathrooms, monthly_rent_cents,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 'Main unit', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        organization.id,
        propertyId,
        property.bedrooms,
        property.bathrooms,
        property.monthly_rent_cents,
        property.status === "occupied" ? "occupied" : "available",
        now,
        now
      );
      unit = this.db.prepare("SELECT * FROM property_units WHERE id = ?").get(id) as Row;
    }
    this.db.prepare(`
      UPDATE property_leases SET unit_id = ?
      WHERE property_id = ? AND (unit_id IS NULL OR unit_id = '')
    `).run(unit.id, propertyId);
    return this.mapUnit(unit);
  }

  createUnit(ownerUserId: string, input: PropertyUnitCreate): PropertyUnit {
    const property = this.requireOwnedProperty(ownerUserId, input.propertyId);
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(ownerUserId).id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_units (
        id, organization_id, property_id, name, bedrooms, bathrooms, monthly_rent_cents,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      input.propertyId,
      input.name,
      input.bedrooms,
      input.bathrooms,
      input.monthlyRentCents,
      input.status,
      now,
      now
    );
    return this.requireUnit(ownerUserId, id);
  }

  createInvitation(
    ownerUserId: string,
    tenantId: string,
    expiresHours: number,
    publicOrigin: string
  ): PropertyTenantInvitation {
    const tenant = this.requireOwnedTenant(ownerUserId, tenantId);
    const organization = this.ensureDefaultOrganization(ownerUserId);
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresHours * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO property_tenant_invitations (
        id, organization_id, tenant_id, email, token_hash, expires_at, accepted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      id,
      organization.id,
      tenantId,
      String(tenant.email),
      tokenHash(token),
      expiresAt,
      now.toISOString()
    );
    return this.mapInvitation(
      this.db.prepare(invitationSelect("i.id = ?")).get(id) as Row,
      `${publicOrigin}/portal/invite?token=${encodeURIComponent(token)}`
    );
  }

  previewInvitation(token: string): PropertyInvitationPreview {
    const row = this.invitationByToken(token);
    if (row.accepted_at) throw new PropertyInvitationError("This invitation has already been accepted");
    if (Date.parse(String(row.expires_at)) <= Date.now()) throw new PropertyInvitationError("This invitation has expired");
    return {
      token,
      tenantName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
      email: String(row.email),
      organizationName: String(row.organization_name),
      expiresAt: String(row.expires_at)
    };
  }

  acceptInvitation(token: string, userId: string): void {
    const row = this.invitationByToken(token);
    if (row.accepted_at) throw new PropertyInvitationError("This invitation has already been accepted");
    if (Date.parse(String(row.expires_at)) <= Date.now()) throw new PropertyInvitationError("This invitation has expired");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE property_tenants SET linked_user_id = ?, updated_at = ? WHERE id = ?")
        .run(userId, now, row.tenant_id);
      this.db.prepare(`
        INSERT OR IGNORE INTO property_organization_members
          (id, organization_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'tenant', ?)
      `).run(randomUUID(), row.organization_id, userId, now);
      this.db.prepare("UPDATE property_tenant_invitations SET accepted_at = ? WHERE id = ?")
        .run(now, row.id);
    })();
  }

  createDocument(
    ownerUserId: string,
    metadata: PropertyDocumentMetadata,
    file: StoredPropertyFile
  ): PropertyDocument {
    const property = this.requireOwnedProperty(ownerUserId, metadata.propertyId);
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(ownerUserId).id;
    this.validateDocumentLinks(ownerUserId, metadata.propertyId, metadata.leaseId, metadata.tenantId);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO property_documents (
          id, organization_id, property_id, lease_id, tenant_id, title, category, visibility,
          requires_acknowledgement, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentId,
        organizationId,
        metadata.propertyId,
        metadata.leaseId,
        metadata.tenantId,
        metadata.title,
        metadata.category,
        metadata.visibility,
        metadata.requiresAcknowledgement ? 1 : 0,
        ownerUserId,
        now,
        now
      );
      this.insertDocumentVersion(versionId, documentId, 1, ownerUserId, file, now);
    })();
    return this.requireDocument(ownerUserId, documentId);
  }

  addDocumentVersion(ownerUserId: string, documentId: string, file: StoredPropertyFile): PropertyDocument {
    const document = this.requireDocument(ownerUserId, documentId, true);
    const latest = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM property_document_versions WHERE document_id = ?")
      .get(documentId) as Row;
    const now = new Date().toISOString();
    this.insertDocumentVersion(randomUUID(), documentId, Number(latest.version) + 1, ownerUserId, file, now);
    this.db.prepare("UPDATE property_documents SET updated_at = ? WHERE id = ?").run(now, documentId);
    return { ...document, latestVersion: this.latestDocumentVersion(documentId) };
  }

  documentVersionForUser(userId: string, versionId: string): PropertyDocumentVersion & { storageKey: string } {
    const row = this.db.prepare(`
      SELECT v.*, d.property_id, d.tenant_id, d.visibility, d.organization_id
      FROM property_document_versions v
      JOIN property_documents d ON d.id = v.document_id
      WHERE v.id = ?
    `).get(versionId) as Row | undefined;
    if (!row || !this.canAccessDocumentRow(userId, row)) throw new PropertyPlatformNotFoundError("Document not found");
    this.db.prepare(`
      INSERT INTO property_document_access_events
        (id, document_id, version_id, user_id, action, created_at)
      VALUES (?, ?, ?, ?, 'download', ?)
    `).run(randomUUID(), row.document_id, versionId, userId, new Date().toISOString());
    return { ...mapDocumentVersion(row), storageKey: String(row.storage_key) };
  }

  acknowledgeDocument(userId: string, documentId: string): PropertyDocument {
    const document = this.requireDocument(userId, documentId);
    if (!document.requiresAcknowledgement) throw new PropertyPlatformAccessError("This document does not require acknowledgement");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_document_acknowledgements (id, document_id, user_id, acknowledged_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(document_id, user_id) DO UPDATE SET acknowledged_at = excluded.acknowledged_at
    `).run(randomUUID(), documentId, userId, now);
    this.db.prepare(`
      INSERT INTO property_document_access_events (id, document_id, version_id, user_id, action, created_at)
      VALUES (?, ?, NULL, ?, 'acknowledge', ?)
    `).run(randomUUID(), documentId, userId, now);
    return this.requireDocument(userId, documentId);
  }

  addRequestComment(
    userId: string,
    requestId: string,
    body: string,
    tenantVisible: boolean,
    authorName: string
  ): PropertyRequestComment {
    const request = this.requireAccessibleRequest(userId, requestId);
    const owner = String(request.owner_user_id) === userId;
    if (!owner && !tenantVisible) throw new PropertyPlatformAccessError("Tenant comments must be visible to the tenant");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_request_comments
        (id, request_id, author_user_id, author_name, body, tenant_visible, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, requestId, userId, authorName, body, tenantVisible ? 1 : 0, now);
    return this.mapRequestComment(this.db.prepare("SELECT * FROM property_request_comments WHERE id = ?").get(id) as Row);
  }

  addRequestAttachment(userId: string, requestId: string, file: StoredPropertyFile): PropertyRequestAttachment {
    this.requireAccessibleRequest(userId, requestId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_request_attachments (
        id, request_id, uploaded_by_user_id, filename, content_type, size_bytes, sha256,
        storage_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      requestId,
      userId,
      file.filename,
      file.contentType,
      file.sizeBytes,
      file.sha256,
      file.storageKey,
      now
    );
    return this.mapRequestAttachment(
      this.db.prepare("SELECT * FROM property_request_attachments WHERE id = ?").get(id) as Row
    );
  }

  assertRequestAccess(userId: string, requestId: string): void {
    this.requireAccessibleRequest(userId, requestId);
  }

  requestAttachmentForUser(userId: string, attachmentId: string): PropertyRequestAttachment & { storageKey: string } {
    const row = this.db.prepare(`
      SELECT a.* FROM property_request_attachments a
      JOIN property_service_requests r ON r.id = a.request_id
      WHERE a.id = ?
    `).get(attachmentId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Request attachment not found");
    this.requireAccessibleRequest(userId, String(row.request_id));
    return { ...this.mapRequestAttachment(row), storageKey: String(row.storage_key) };
  }

  recordRequestCreated(actorUserId: string, requestId: string): void {
    const request = this.requireAccessibleRequest(actorUserId, requestId);
    this.db.prepare(`
      INSERT INTO property_request_status_history
        (id, request_id, from_status, to_status, actor_user_id, created_at)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run(randomUUID(), requestId, request.status, actorUserId, new Date().toISOString());
  }

  recordRequestStatus(
    actorUserId: string,
    requestId: string,
    fromStatus: PropertyServiceRequestStatus,
    toStatus: PropertyServiceRequestStatus
  ): void {
    this.requireAccessibleRequest(actorUserId, requestId);
    if (fromStatus === toStatus) return;
    this.db.prepare(`
      INSERT INTO property_request_status_history
        (id, request_id, from_status, to_status, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), requestId, fromStatus, toStatus, actorUserId, new Date().toISOString());
  }

  assignRequest(ownerUserId: string, requestId: string, assigneeUserId: string | null, targetDate: string | null): void {
    const request = this.db.prepare("SELECT * FROM property_service_requests WHERE id = ? AND owner_user_id = ?")
      .get(requestId, ownerUserId) as Row | undefined;
    if (!request) throw new PropertyPlatformNotFoundError("Service request not found");
    this.db.prepare(`
      INSERT INTO property_request_assignments
        (id, request_id, assignee_user_id, target_date, assigned_by_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        assignee_user_id = excluded.assignee_user_id,
        target_date = excluded.target_date,
        assigned_by_user_id = excluded.assigned_by_user_id,
        updated_at = excluded.updated_at
    `).run(randomUUID(), requestId, assigneeUserId, targetDate, ownerUserId, new Date().toISOString());
  }

  createRentSchedule(ownerUserId: string, input: PropertyRentScheduleCreate): PropertyRentSchedule {
    const property = this.requireOwnedProperty(ownerUserId, input.propertyId);
    const lease = this.db.prepare("SELECT * FROM property_leases WHERE id = ? AND owner_user_id = ?")
      .get(input.leaseId, ownerUserId) as Row | undefined;
    if (!lease || String(lease.property_id) !== input.propertyId) {
      throw new PropertyPlatformNotFoundError("Lease not found");
    }
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(ownerUserId).id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_rent_schedules (
        id, organization_id, property_id, lease_id, amount_cents, due_day,
        description_template, next_charge_date, reminder_days_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      input.propertyId,
      input.leaseId,
      input.amountCents,
      input.dueDay,
      input.descriptionTemplate,
      input.nextChargeDate,
      JSON.stringify([...new Set(input.reminderDays)].sort((a, b) => a - b)),
      input.enabled ? 1 : 0,
      now,
      now
    );
    return this.requireRentSchedule(ownerUserId, id);
  }

  dueRentSchedules(today: string): PropertyRentSchedule[] {
    return (this.db.prepare(`
      SELECT s.*, p.name AS property_name
      FROM property_rent_schedules s
      JOIN managed_properties p ON p.id = s.property_id
      WHERE s.enabled = 1 AND s.next_charge_date <= ?
      ORDER BY s.next_charge_date
    `).all(today) as Row[]).map(mapRentSchedule);
  }

  rentScheduleOwnerUserId(scheduleId: string): string {
    const row = this.db.prepare(`
      SELECT p.owner_user_id FROM property_rent_schedules s
      JOIN managed_properties p ON p.id = s.property_id
      WHERE s.id = ?
    `).get(scheduleId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Rent schedule not found");
    return String(row.owner_user_id);
  }

  claimRentScheduleRun(scheduleId: string, chargeDate: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO property_rent_schedule_runs
        (id, schedule_id, charge_date, status, created_at, completed_at)
      VALUES (?, ?, ?, 'running', ?, NULL)
    `).run(randomUUID(), scheduleId, chargeDate, new Date().toISOString());
    return result.changes === 1;
  }

  completeRentScheduleRun(scheduleId: string, chargeDate: string, chargeId: string): void {
    const nextDate = addMonth(chargeDate);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE property_rent_schedule_runs SET status = 'completed', charge_id = ?, completed_at = ?
        WHERE schedule_id = ? AND charge_date = ?
      `).run(chargeId, now, scheduleId, chargeDate);
      this.db.prepare("UPDATE property_rent_schedules SET next_charge_date = ?, updated_at = ? WHERE id = ?")
        .run(nextDate, now, scheduleId);
    })();
  }

  failRentScheduleRun(scheduleId: string, chargeDate: string, error: string): void {
    this.db.prepare(`
      UPDATE property_rent_schedule_runs SET status = 'failed', error = ?, completed_at = ?
      WHERE schedule_id = ? AND charge_date = ?
    `).run(error, new Date().toISOString(), scheduleId, chargeDate);
  }

  recordCharge(
    ownerUserId: string,
    charge: { id: string; propertyId: string; leaseId: string | null; amountCents: number; description: string; dueDate: string }
  ): PropertyLedgerEntry {
    const property = this.requireOwnedProperty(ownerUserId, charge.propertyId);
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(ownerUserId).id;
    return this.insertLedgerEntry({
      organizationId,
      propertyId: charge.propertyId,
      leaseId: charge.leaseId,
      chargeId: charge.id,
      paymentId: null,
      entryType: "charge",
      amountCents: charge.amountCents,
      description: charge.description,
      effectiveAt: `${charge.dueDate}T12:00:00.000Z`,
      uniqueKey: `charge:${charge.id}`
    });
  }

  enqueueChargeReminders(chargeId: string, reminderDays: number[]): number {
    const row = this.db.prepare(`
      SELECT c.*, p.organization_id, p.name AS property_name,
        t.id AS tenant_id, t.linked_user_id, t.first_name, t.email, t.phone
      FROM property_rent_charges c
      JOIN managed_properties p ON p.id = c.property_id
      LEFT JOIN property_leases l ON l.id = c.lease_id
      LEFT JOIN property_tenants t ON t.id = l.tenant_id
      WHERE c.id = ?
    `).get(chargeId) as Row | undefined;
    if (!row || !row.organization_id || !row.tenant_id) return 0;
    let queued = 0;
    for (const offset of [...new Set(reminderDays)]) {
      const scheduledAt = offsetDateTime(String(row.due_date), offset);
      const timing = offset < 0
        ? `due in ${Math.abs(offset)} day${Math.abs(offset) === 1 ? "" : "s"}`
        : offset === 0
          ? "due today"
          : `${offset} day${offset === 1 ? "" : "s"} overdue`;
      const subject = `Rent reminder: ${String(row.property_name)} is ${timing}`;
      const body = `Hello ${String(row.first_name)},\n\n${String(row.description)} for ${String(row.property_name)} is ${timing}. Amount: ${formatCents(Number(row.amount_cents))}. Due date: ${String(row.due_date)}.\n\nPlease use the tenant portal to review your balance or payment options.`;
      const channels: Array<{ channel: PropertyNotificationChannel; recipient: string }> = [];
      if (row.linked_user_id) channels.push({ channel: "in_app", recipient: String(row.linked_user_id) });
      if (row.email) channels.push({ channel: "email", recipient: String(row.email) });
      if (row.phone && this.canSendSms(String(row.tenant_id), String(row.phone))) {
        channels.push({ channel: "sms", recipient: String(row.phone) });
      }
      for (const delivery of channels) {
        this.enqueueNotification({
          organizationId: String(row.organization_id),
          tenantId: String(row.tenant_id),
          chargeId,
          channel: delivery.channel,
          recipient: delivery.recipient,
          subject,
          body,
          scheduledAt,
          idempotencyKey: `rent-reminder:${chargeId}:${offset}:${delivery.channel}`
        });
        queued += 1;
      }
    }
    return queued;
  }

  recordSuccessfulPayment(payment: {
    id: string;
    propertyId: string;
    leaseId: string | null;
    chargeId: string | null;
    amountCents: number;
    paidAt: string | null;
    propertyName: string;
  }): { ledgerEntry: PropertyLedgerEntry; receipt: PropertyReceipt } {
    const property = this.db.prepare("SELECT * FROM managed_properties WHERE id = ?").get(payment.propertyId) as Row | undefined;
    if (!property) throw new PropertyPlatformNotFoundError("Property not found");
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(String(property.owner_user_id)).id;
    const ledgerEntry = this.insertLedgerEntry({
      organizationId,
      propertyId: payment.propertyId,
      leaseId: payment.leaseId,
      chargeId: payment.chargeId,
      paymentId: payment.id,
      entryType: "payment",
      amountCents: -payment.amountCents,
      description: `Payment received - ${payment.propertyName}`,
      effectiveAt: payment.paidAt ?? new Date().toISOString(),
      uniqueKey: `payment:${payment.id}`
    });
    if (payment.chargeId) {
      this.db.prepare(`
        INSERT OR IGNORE INTO property_payment_allocations
          (id, payment_id, charge_id, amount_cents, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), payment.id, payment.chargeId, payment.amountCents, new Date().toISOString());
    }
    return { ledgerEntry, receipt: this.ensureReceipt(payment) };
  }

  addAdjustment(ownerUserId: string, input: PropertyLedgerAdjustment): PropertyLedgerEntry {
    const property = this.requireOwnedProperty(ownerUserId, input.propertyId);
    const organizationId = optionalString(property.organization_id)
      ?? this.ensureDefaultOrganization(ownerUserId).id;
    return this.insertLedgerEntry({
      organizationId,
      propertyId: input.propertyId,
      leaseId: input.leaseId,
      chargeId: input.chargeId,
      paymentId: null,
      entryType: "adjustment",
      amountCents: input.amountCents,
      description: input.description,
      effectiveAt: input.effectiveAt,
      uniqueKey: null
    });
  }

  recordRefund(paymentId: string, amountCents: number, description: string, refundId: string = randomUUID()): PropertyLedgerEntry {
    const payment = this.db.prepare("SELECT * FROM property_payments WHERE id = ?").get(paymentId) as Row | undefined;
    if (!payment) throw new PropertyPlatformNotFoundError("Payment not found");
    const property = this.db.prepare("SELECT * FROM managed_properties WHERE id = ?").get(payment.property_id) as Row;
    return this.insertLedgerEntry({
      organizationId: String(property.organization_id),
      propertyId: String(payment.property_id),
      leaseId: optionalString(payment.lease_id),
      chargeId: optionalString(payment.charge_id),
      paymentId,
      entryType: "refund",
      amountCents,
      description,
      effectiveAt: new Date().toISOString(),
      uniqueKey: `refund:${paymentId}:${refundId}`
    });
  }

  enqueueNotification(input: {
    organizationId: string;
    tenantId: string | null;
    chargeId: string | null;
    channel: PropertyNotificationChannel;
    recipient: string;
    subject: string;
    body: string;
    scheduledAt: string;
    idempotencyKey: string;
  }): PropertyNotificationJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO property_notification_jobs (
        id, organization_id, tenant_id, charge_id, channel, recipient, subject, body,
        scheduled_at, status, attempts, max_attempts, next_attempt_at, last_error,
        idempotency_key, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 5, ?, NULL, ?, ?, NULL)
    `).run(
      id,
      input.organizationId,
      input.tenantId,
      input.chargeId,
      input.channel,
      input.recipient,
      input.subject,
      input.body,
      input.scheduledAt,
      input.scheduledAt,
      input.idempotencyKey,
      now
    );
    const row = this.db.prepare("SELECT * FROM property_notification_jobs WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as Row;
    return mapNotificationJob(row);
  }

  claimNotificationJob(now: string): ClaimedNotificationJob | null {
    const row = this.db.prepare(`
      SELECT * FROM property_notification_jobs
      WHERE status = 'queued' AND scheduled_at <= ? AND next_attempt_at <= ?
      ORDER BY scheduled_at, created_at LIMIT 1
    `).get(now, now) as Row | undefined;
    if (!row) return null;
    const result = this.db.prepare(`
      UPDATE property_notification_jobs
      SET status = 'running', attempts = attempts + 1
      WHERE id = ? AND status = 'queued'
    `).run(row.id);
    if (result.changes !== 1) return null;
    const claimed = this.db.prepare("SELECT * FROM property_notification_jobs WHERE id = ?").get(row.id) as Row;
    return { ...mapNotificationJob(claimed), idempotencyKey: String(claimed.idempotency_key) };
  }

  completeNotificationJob(
    jobId: string,
    provider: string,
    providerId: string | null,
    status: "succeeded" | "suppressed",
    error: string | null = null
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO property_delivery_attempts
          (id, job_id, provider, provider_id, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), jobId, provider, providerId, status, error, now);
      this.db.prepare(`
        UPDATE property_notification_jobs SET status = 'completed', completed_at = ?, last_error = ?
        WHERE id = ?
      `).run(now, error, jobId);
    })();
  }

  failNotificationJob(jobId: string, error: string): void {
    const row = this.db.prepare("SELECT attempts, max_attempts FROM property_notification_jobs WHERE id = ?")
      .get(jobId) as Row | undefined;
    if (!row) return;
    const attempts = Number(row.attempts);
    const failed = attempts >= Number(row.max_attempts);
    const nextAttempt = new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO property_delivery_attempts
          (id, job_id, provider, provider_id, status, error, created_at)
        VALUES (?, ?, 'system', NULL, 'failed', ?, ?)
      `).run(randomUUID(), jobId, error, now);
      this.db.prepare(`
        UPDATE property_notification_jobs
        SET status = ?, next_attempt_at = ?, last_error = ?, completed_at = ?
        WHERE id = ?
      `).run(failed ? "failed" : "queued", nextAttempt, error, failed ? now : null, jobId);
    })();
  }

  setConsent(
    userId: string,
    input: {
      tenantId: string;
      channel: "email" | "sms";
      destination: string;
      status: "opted_in" | "opted_out";
      source: string;
    }
  ): PropertyCommunicationConsent {
    const tenant = this.db.prepare(`
      SELECT * FROM property_tenants
      WHERE id = ? AND (owner_user_id = ? OR linked_user_id = ?)
    `).get(input.tenantId, userId, userId) as Row | undefined;
    if (!tenant) throw new PropertyPlatformNotFoundError("Tenant not found");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_communication_consents (
        id, tenant_id, channel, destination, status, source, consented_at, revoked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, channel, destination) DO UPDATE SET
        status = excluded.status,
        source = excluded.source,
        consented_at = excluded.consented_at,
        revoked_at = excluded.revoked_at,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(),
      input.tenantId,
      input.channel,
      input.destination,
      input.status,
      input.source,
      input.status === "opted_in" ? now : null,
      input.status === "opted_out" ? now : null,
      now
    );
    return this.mapConsent(this.db.prepare(`
      SELECT * FROM property_communication_consents
      WHERE tenant_id = ? AND channel = ? AND destination = ?
    `).get(input.tenantId, input.channel, input.destination) as Row);
  }

  canSendSms(tenantId: string | null, destination: string): boolean {
    if (!tenantId) return false;
    const row = this.db.prepare(`
      SELECT status FROM property_communication_consents
      WHERE tenant_id = ? AND channel = 'sms' AND destination = ?
    `).get(tenantId, destination) as Row | undefined;
    return row?.status === "opted_in";
  }

  recordSmsOptOut(destination: string, source = "Twilio STOP webhook"): number {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT id, tenant_id FROM property_communication_consents
      WHERE channel = 'sms' AND destination = ?
    `).all(destination) as Row[];
    for (const row of rows) {
      this.db.prepare(`
        UPDATE property_communication_consents
        SET status = 'opted_out', source = ?, revoked_at = ?, updated_at = ?
        WHERE id = ?
      `).run(source, now, now, row.id);
    }
    return rows.length;
  }

  enqueueProviderEvent(
    provider: "stripe" | "paypal",
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO property_provider_events (
        id, provider, event_id, event_type, payload_json, status, attempts,
        last_error, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, ?, NULL)
    `).run(randomUUID(), provider, eventId, eventType, JSON.stringify(payload), new Date().toISOString());
    return result.changes === 1;
  }

  claimProviderEvent(): ClaimedProviderEvent | null {
    const row = this.db.prepare(`
      SELECT * FROM property_provider_events
      WHERE status = 'queued' ORDER BY created_at LIMIT 1
    `).get() as Row | undefined;
    if (!row) return null;
    const result = this.db.prepare(`
      UPDATE property_provider_events SET status = 'running', attempts = attempts + 1
      WHERE id = ? AND status = 'queued'
    `).run(row.id);
    if (result.changes !== 1) return null;
    const claimed = this.db.prepare("SELECT * FROM property_provider_events WHERE id = ?").get(row.id) as Row;
    return {
      id: String(claimed.id),
      provider: claimed.provider as "stripe" | "paypal",
      eventId: String(claimed.event_id),
      eventType: String(claimed.event_type),
      payload: JSON.parse(String(claimed.payload_json)) as Record<string, unknown>,
      attempts: Number(claimed.attempts)
    };
  }

  completeProviderEvent(id: string): void {
    this.db.prepare(`
      UPDATE property_provider_events SET status = 'completed', processed_at = ?, last_error = NULL
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  failProviderEvent(id: string, error: string, retry: boolean): void {
    this.db.prepare(`
      UPDATE property_provider_events SET status = ?, last_error = ?, processed_at = ?
      WHERE id = ?
    `).run(retry ? "queued" : "failed", error, retry ? null : new Date().toISOString(), id);
  }

  overview(userId: string, integrations: PropertyIntegrationSettings): PropertyPlatformOverview {
    const organizationIds = this.accessibleOrganizationIds(userId);
    if (organizationIds.length === 0) {
      return emptyOverview(integrations);
    }
    const placeholders = organizationIds.map(() => "?").join(",");
    const manager = this.isManager(userId);
    const documents = this.listDocuments(userId, organizationIds);
    const requests = this.accessibleRequestIds(userId);
    const requestPlaceholders = requests.length ? requests.map(() => "?").join(",") : "NULL";
    const comments = requests.length
      ? (this.db.prepare(`
          SELECT * FROM property_request_comments WHERE request_id IN (${requestPlaceholders})
          AND (tenant_visible = 1 OR author_user_id = ?) ORDER BY created_at
        `).all(...requests, userId) as Row[]).map((row) => this.mapRequestComment(row))
      : [];
    const history = requests.length
      ? (this.db.prepare(`
          SELECT * FROM property_request_status_history WHERE request_id IN (${requestPlaceholders})
          ORDER BY created_at
        `).all(...requests) as Row[]).map(mapStatusEvent)
      : [];
    const attachments = requests.length
      ? (this.db.prepare(`
          SELECT * FROM property_request_attachments WHERE request_id IN (${requestPlaceholders})
          ORDER BY created_at
        `).all(...requests) as Row[]).map((row) => this.mapRequestAttachment(row))
      : [];
    const ledgerRows = manager
      ? this.db.prepare(`
          SELECT * FROM property_ledger_entries WHERE organization_id IN (${placeholders})
          ORDER BY effective_at DESC, created_at DESC LIMIT 500
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT l.* FROM property_ledger_entries l
          JOIN property_leases lease ON lease.id = l.lease_id
          JOIN property_tenants tenant ON tenant.id = lease.tenant_id
          WHERE l.organization_id IN (${placeholders}) AND tenant.linked_user_id = ?
          ORDER BY l.effective_at DESC, l.created_at DESC LIMIT 500
        `).all(...organizationIds, userId);
    const ledger = (ledgerRows as Row[]).map(mapLedgerEntry);
    const jobRows = manager
      ? this.db.prepare(`
          SELECT * FROM property_notification_jobs WHERE organization_id IN (${placeholders})
          ORDER BY scheduled_at DESC LIMIT 250
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT j.* FROM property_notification_jobs j
          JOIN property_tenants t ON t.id = j.tenant_id
          WHERE j.organization_id IN (${placeholders}) AND t.linked_user_id = ?
          ORDER BY j.scheduled_at DESC LIMIT 250
        `).all(...organizationIds, userId);
    const jobs = (jobRows as Row[]).map(mapNotificationJob);
    const jobIds = jobs.map((job) => job.id);
    const deliveries = jobIds.length
      ? (this.db.prepare(`
          SELECT * FROM property_delivery_attempts WHERE job_id IN (${jobIds.map(() => "?").join(",")})
          ORDER BY created_at DESC LIMIT 500
        `).all(...jobIds) as Row[]).map(mapDeliveryAttempt)
      : [];
    const organizationRows = this.db.prepare(`
      SELECT * FROM property_organizations WHERE id IN (${placeholders}) ORDER BY name
    `).all(...organizationIds) as Row[];
    const report = manager ? this.report(userId, organizationIds) : tenantReport(ledger, requests.length, jobs);
    const membershipRows = manager
      ? this.db.prepare(`
          SELECT m.*, u.display_name FROM property_organization_members m
          JOIN users u ON u.id = m.user_id
          WHERE m.organization_id IN (${placeholders}) ORDER BY u.display_name
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT m.*, u.display_name FROM property_organization_members m
          JOIN users u ON u.id = m.user_id
          WHERE m.organization_id IN (${placeholders}) AND m.user_id = ? ORDER BY u.display_name
        `).all(...organizationIds, userId);
    const unitRows = manager
      ? this.db.prepare(`
          SELECT u.*, p.name AS property_name FROM property_units u
          JOIN managed_properties p ON p.id = u.property_id
          WHERE u.organization_id IN (${placeholders}) ORDER BY p.name, u.name
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT DISTINCT u.*, p.name AS property_name FROM property_units u
          JOIN managed_properties p ON p.id = u.property_id
          JOIN property_leases l ON l.unit_id = u.id
          JOIN property_tenants t ON t.id = l.tenant_id
          WHERE u.organization_id IN (${placeholders}) AND t.linked_user_id = ?
          ORDER BY p.name, u.name
        `).all(...organizationIds, userId);
    const scheduleRows = manager
      ? this.db.prepare(`
          SELECT s.*, p.name AS property_name FROM property_rent_schedules s
          JOIN managed_properties p ON p.id = s.property_id
          WHERE s.organization_id IN (${placeholders}) ORDER BY s.next_charge_date
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT s.*, p.name AS property_name FROM property_rent_schedules s
          JOIN managed_properties p ON p.id = s.property_id
          JOIN property_leases l ON l.id = s.lease_id
          JOIN property_tenants t ON t.id = l.tenant_id
          WHERE s.organization_id IN (${placeholders}) AND t.linked_user_id = ?
          ORDER BY s.next_charge_date
        `).all(...organizationIds, userId);
    const receiptRows = manager
      ? this.db.prepare(`
          SELECT r.* FROM property_receipts r
          JOIN property_payments pay ON pay.id = r.payment_id
          WHERE pay.owner_user_id IN (
            SELECT owner_user_id FROM property_organizations WHERE id IN (${placeholders})
          ) ORDER BY r.created_at DESC
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT r.* FROM property_receipts r
          JOIN property_payments pay ON pay.id = r.payment_id
          JOIN property_leases l ON l.id = pay.lease_id
          JOIN property_tenants t ON t.id = l.tenant_id
          WHERE t.linked_user_id = ? ORDER BY r.created_at DESC
        `).all(userId);
    const consentRows = manager
      ? this.db.prepare(`
          SELECT c.* FROM property_communication_consents c
          JOIN property_tenants t ON t.id = c.tenant_id
          WHERE t.owner_user_id IN (
            SELECT owner_user_id FROM property_organizations WHERE id IN (${placeholders})
          ) ORDER BY c.updated_at DESC
        `).all(...organizationIds)
      : this.db.prepare(`
          SELECT c.* FROM property_communication_consents c
          JOIN property_tenants t ON t.id = c.tenant_id
          WHERE t.linked_user_id = ? ORDER BY c.updated_at DESC
        `).all(userId);
    return {
      organizations: organizationRows.map(mapOrganization),
      memberships: (membershipRows as Row[]).map(mapMembership),
      units: (unitRows as Row[]).map((row) => this.mapUnit(row)),
      invitations: manager
        ? (this.db.prepare(`${invitationSelect(`i.organization_id IN (${placeholders})`)} ORDER BY i.created_at DESC`)
            .all(...organizationIds) as Row[]).map((row) => this.mapInvitation(row, null))
        : [],
      documents,
      requestComments: comments,
      requestStatusHistory: history,
      requestAttachments: attachments,
      rentSchedules: (scheduleRows as Row[]).map(mapRentSchedule),
      ledgerEntries: ledger,
      receipts: (receiptRows as Row[]).map(mapReceipt),
      notificationJobs: jobs,
      deliveryAttempts: deliveries,
      consents: (consentRows as Row[]).map((row) => this.mapConsent(row)),
      integrations: manager ? integrations : hiddenIntegrations(integrations),
      report
    };
  }

  report(_userId: string, organizationIds: string[]): PropertyOperationsReport {
    if (organizationIds.length === 0) return emptyReport();
    const placeholders = organizationIds.map(() => "?").join(",");
    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'charge' THEN amount_cents ELSE 0 END), 0) AS charges,
        COALESCE(SUM(CASE WHEN entry_type = 'payment' THEN -amount_cents ELSE 0 END), 0) AS payments,
        COALESCE(SUM(CASE WHEN entry_type IN ('adjustment', 'refund') THEN amount_cents ELSE 0 END), 0) AS adjustments,
        COALESCE(SUM(amount_cents), 0) AS outstanding
      FROM property_ledger_entries WHERE organization_id IN (${placeholders})
    `).get(...organizationIds) as Row;
    const ownerIds = this.db.prepare(`
      SELECT owner_user_id FROM property_organizations WHERE id IN (${placeholders})
    `).all(...organizationIds).map((row) => String((row as Row).owner_user_id));
    const ownerPlaceholders = ownerIds.map(() => "?").join(",") || "NULL";
    const operational = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM property_rent_charges WHERE owner_user_id IN (${ownerPlaceholders})
          AND status != 'void' AND due_date < date('now')) AS overdue_charges,
        (SELECT COUNT(*) FROM property_service_requests WHERE owner_user_id IN (${ownerPlaceholders})
          AND status NOT IN ('completed', 'cancelled')) AS open_requests,
        (SELECT COUNT(*) FROM property_leases WHERE owner_user_id IN (${ownerPlaceholders})
          AND status = 'active' AND end_date <= date('now', '+90 days')) AS expiring_leases,
        (SELECT COUNT(*) FROM property_notification_jobs WHERE organization_id IN (${placeholders})
          AND status IN ('queued', 'running')) AS queued_notifications
    `).get(...ownerIds, ...ownerIds, ...ownerIds, ...organizationIds) as Row;
    return {
      generatedAt: new Date().toISOString(),
      totalChargesCents: Number(totals.charges),
      totalPaymentsCents: Number(totals.payments),
      totalAdjustmentsCents: Number(totals.adjustments),
      outstandingCents: Number(totals.outstanding),
      overdueCharges: Number(operational.overdue_charges),
      openRequests: Number(operational.open_requests),
      expiringLeases: Number(operational.expiring_leases),
      queuedNotifications: Number(operational.queued_notifications)
    };
  }

  financialCsv(userId: string): string {
    const organizationIds = this.accessibleOrganizationIds(userId);
    if (organizationIds.length === 0) return "effective_at,type,property,description,amount\n";
    const placeholders = organizationIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT l.effective_at, l.entry_type, p.name AS property_name, l.description, l.amount_cents
      FROM property_ledger_entries l JOIN managed_properties p ON p.id = l.property_id
      WHERE l.organization_id IN (${placeholders}) ORDER BY l.effective_at, l.created_at
    `).all(...organizationIds) as Row[];
    return [
      "effective_at,type,property,description,amount",
      ...rows.map((row) => [
        row.effective_at,
        row.entry_type,
        csv(String(row.property_name)),
        csv(String(row.description)),
        (Number(row.amount_cents) / 100).toFixed(2)
      ].join(","))
    ].join("\n") + "\n";
  }

  private initialize(): void {
    this.addColumn("managed_properties", "organization_id", "TEXT");
    this.addColumn("property_leases", "unit_id", "TEXT");
    this.addColumn("property_payments", "provider_transaction_id", "TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS property_organizations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_organization_members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(organization_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS property_units (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        bedrooms REAL,
        bathrooms REAL,
        monthly_rent_cents INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_tenant_invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_documents (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,
        tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        visibility TEXT NOT NULL,
        requires_acknowledgement INTEGER NOT NULL DEFAULT 0,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, version)
      );
      CREATE TABLE IF NOT EXISTS property_document_acknowledgements (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        UNIQUE(document_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS property_document_access_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,
        version_id TEXT REFERENCES property_document_versions(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_request_comments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,
        author_user_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        tenant_visible INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_request_attachments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,
        uploaded_by_user_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_request_status_history (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_request_assignments (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES property_service_requests(id) ON DELETE CASCADE,
        assignee_user_id TEXT,
        target_date TEXT,
        assigned_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_rent_schedules (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        due_day INTEGER NOT NULL,
        description_template TEXT NOT NULL,
        next_charge_date TEXT NOT NULL,
        reminder_days_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_rent_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES property_rent_schedules(id) ON DELETE CASCADE,
        charge_date TEXT NOT NULL,
        charge_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(schedule_id, charge_date)
      );
      CREATE TABLE IF NOT EXISTS property_payment_allocations (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES property_payments(id) ON DELETE CASCADE,
        charge_id TEXT NOT NULL REFERENCES property_rent_charges(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(payment_id, charge_id)
      );
      CREATE TABLE IF NOT EXISTS property_ledger_entries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,
        charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,
        payment_id TEXT REFERENCES property_payments(id) ON DELETE SET NULL,
        entry_type TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        unique_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_receipts (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL UNIQUE REFERENCES property_payments(id) ON DELETE CASCADE,
        receipt_number TEXT NOT NULL UNIQUE,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_notification_jobs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,
        tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,
        charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS property_delivery_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES property_notification_jobs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_communication_consents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        consented_at TEXT,
        revoked_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, channel, destination)
      );
      CREATE TABLE IF NOT EXISTS property_provider_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(provider, event_id)
      );
      CREATE INDEX IF NOT EXISTS property_org_members_user_idx
        ON property_organization_members(user_id, organization_id);
      CREATE INDEX IF NOT EXISTS property_units_property_idx ON property_units(property_id);
      CREATE INDEX IF NOT EXISTS property_documents_org_idx ON property_documents(organization_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS property_comments_request_idx ON property_request_comments(request_id, created_at);
      CREATE INDEX IF NOT EXISTS property_ledger_org_idx ON property_ledger_entries(organization_id, effective_at DESC);
      CREATE INDEX IF NOT EXISTS property_notification_due_idx
        ON property_notification_jobs(status, scheduled_at, next_attempt_at);
      CREATE INDEX IF NOT EXISTS property_provider_event_status_idx
        ON property_provider_events(status, created_at);
    `);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE property_notification_jobs SET status = 'queued', next_attempt_at = ?, last_error = 'Interrupted by restart'
      WHERE status = 'running'
    `).run(now);
    this.db.prepare(`
      UPDATE property_provider_events SET status = 'queued', last_error = 'Interrupted by restart'
      WHERE status = 'running'
    `).run();
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureUnits(ownerUserId: string, organizationId: string): void {
    const properties = this.db.prepare("SELECT id FROM managed_properties WHERE owner_user_id = ?")
      .all(ownerUserId) as Row[];
    for (const property of properties) this.syncPropertyWithoutEnsure(ownerUserId, organizationId, String(property.id));
  }

  private syncPropertyWithoutEnsure(ownerUserId: string, organizationId: string, propertyId: string): void {
    const property = this.requireOwnedProperty(ownerUserId, propertyId);
    this.db.prepare("UPDATE managed_properties SET organization_id = ? WHERE id = ?")
      .run(organizationId, propertyId);
    const existing = this.db.prepare("SELECT id FROM property_units WHERE property_id = ? LIMIT 1").get(propertyId) as Row | undefined;
    if (existing) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_units (
        id, organization_id, property_id, name, bedrooms, bathrooms, monthly_rent_cents,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'Main unit', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      propertyId,
      property.bedrooms,
      property.bathrooms,
      property.monthly_rent_cents,
      property.status === "occupied" ? "occupied" : "available",
      now,
      now
    );
    this.db.prepare(`UPDATE property_leases SET unit_id = ? WHERE property_id = ? AND unit_id IS NULL`)
      .run(id, propertyId);
  }

  private insertDocumentVersion(
    id: string,
    documentId: string,
    version: number,
    userId: string,
    file: StoredPropertyFile,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO property_document_versions (
        id, document_id, version, filename, content_type, size_bytes, sha256,
        storage_key, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      documentId,
      version,
      file.filename,
      file.contentType,
      file.sizeBytes,
      file.sha256,
      file.storageKey,
      userId,
      createdAt
    );
  }

  private latestDocumentVersion(documentId: string): PropertyDocumentVersion {
    const row = this.db.prepare(`
      SELECT * FROM property_document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1
    `).get(documentId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Document version not found");
    return mapDocumentVersion(row);
  }

  private requireDocument(userId: string, documentId: string, ownerOnly = false): PropertyDocument {
    const row = this.db.prepare(`
      SELECT d.*, p.name AS property_name,
        (SELECT acknowledged_at FROM property_document_acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = ?) AS acknowledged_at
      FROM property_documents d JOIN managed_properties p ON p.id = d.property_id
      WHERE d.id = ?
    `).get(userId, documentId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Document not found");
    if (ownerOnly) {
      const owned = this.db.prepare(`
        SELECT 1 FROM property_documents d JOIN managed_properties p ON p.id = d.property_id
        WHERE d.id = ? AND p.owner_user_id = ?
      `).get(documentId, userId);
      if (!owned) throw new PropertyPlatformNotFoundError("Document not found");
    } else if (!this.canAccessDocumentRow(userId, row)) {
      throw new PropertyPlatformNotFoundError("Document not found");
    }
    return this.mapDocument(row);
  }

  private listDocuments(userId: string, organizationIds: string[]): PropertyDocument[] {
    const placeholders = organizationIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT d.*, p.name AS property_name,
        (SELECT acknowledged_at FROM property_document_acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = ?) AS acknowledged_at
      FROM property_documents d JOIN managed_properties p ON p.id = d.property_id
      WHERE d.organization_id IN (${placeholders}) ORDER BY d.updated_at DESC
    `).all(userId, ...organizationIds) as Row[];
    return rows.filter((row) => this.canAccessDocumentRow(userId, row)).map((row) => this.mapDocument(row));
  }

  private mapDocument(row: Row): PropertyDocument {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      propertyId: String(row.property_id),
      propertyName: String(row.property_name),
      leaseId: optionalString(row.lease_id),
      tenantId: optionalString(row.tenant_id),
      title: String(row.title),
      category: String(row.category),
      visibility: row.visibility as PropertyDocument["visibility"],
      requiresAcknowledgement: Boolean(row.requires_acknowledgement),
      acknowledgedAt: optionalString(row.acknowledged_at),
      latestVersion: this.latestDocumentVersion(String(row.id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private canAccessDocumentRow(userId: string, row: Row): boolean {
    const manager = this.db.prepare(`
      SELECT 1 FROM property_organizations o
      LEFT JOIN property_organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND (o.owner_user_id = ? OR (m.user_id = ? AND m.role IN ('owner','manager')))
      LIMIT 1
    `).get(row.organization_id, userId, userId);
    if (manager) return true;
    if (row.visibility !== "tenant") return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM property_tenants t
      JOIN property_leases l ON l.tenant_id = t.id
      WHERE t.linked_user_id = ? AND l.property_id = ?
        AND (? IS NULL OR l.id = ?)
        AND (? IS NULL OR t.id = ?)
      LIMIT 1
    `).get(userId, row.property_id, row.lease_id, row.lease_id, row.tenant_id, row.tenant_id));
  }

  private validateDocumentLinks(
    ownerUserId: string,
    propertyId: string,
    leaseId: string | null,
    tenantId: string | null
  ): void {
    if (leaseId) {
      const lease = this.db.prepare("SELECT * FROM property_leases WHERE id = ? AND owner_user_id = ?")
        .get(leaseId, ownerUserId) as Row | undefined;
      if (!lease || String(lease.property_id) !== propertyId) throw new PropertyPlatformNotFoundError("Lease not found");
    }
    if (tenantId) this.requireOwnedTenant(ownerUserId, tenantId);
  }

  private accessibleOrganizationIds(userId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT o.id FROM property_organizations o
      LEFT JOIN property_organization_members m ON m.organization_id = o.id
      LEFT JOIN property_tenants t ON t.owner_user_id = o.owner_user_id
      WHERE o.owner_user_id = ? OR m.user_id = ? OR t.linked_user_id = ?
    `).all(userId, userId, userId) as Row[];
    return rows.map((row) => String(row.id));
  }

  private accessibleRequestIds(userId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT r.id FROM property_service_requests r
      LEFT JOIN property_tenants t ON t.id = r.tenant_id
      WHERE r.owner_user_id = ? OR t.linked_user_id = ?
    `).all(userId, userId) as Row[];
    return rows.map((row) => String(row.id));
  }

  private requireAccessibleRequest(userId: string, requestId: string): Row {
    const row = this.db.prepare(`
      SELECT r.* FROM property_service_requests r
      LEFT JOIN property_tenants t ON t.id = r.tenant_id
      WHERE r.id = ? AND (r.owner_user_id = ? OR t.linked_user_id = ?)
    `).get(requestId, userId, userId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Service request not found");
    return row;
  }

  private requireOrganization(userId: string, organizationId: string): PropertyOrganization {
    const row = this.db.prepare(`
      SELECT o.* FROM property_organizations o
      LEFT JOIN property_organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND (o.owner_user_id = ? OR m.user_id = ?) LIMIT 1
    `).get(organizationId, userId, userId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Organization not found");
    return mapOrganization(row);
  }

  private requireOwnedProperty(ownerUserId: string, propertyId: string): Row {
    const row = this.db.prepare("SELECT * FROM managed_properties WHERE id = ? AND owner_user_id = ?")
      .get(propertyId, ownerUserId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Property not found");
    return row;
  }

  private requireOwnedTenant(ownerUserId: string, tenantId: string): Row {
    const row = this.db.prepare("SELECT * FROM property_tenants WHERE id = ? AND owner_user_id = ?")
      .get(tenantId, ownerUserId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Tenant not found");
    return row;
  }

  private requireUnit(ownerUserId: string, unitId: string): PropertyUnit {
    const row = this.db.prepare(`
      SELECT u.*, p.name AS property_name FROM property_units u
      JOIN managed_properties p ON p.id = u.property_id
      WHERE u.id = ? AND p.owner_user_id = ?
    `).get(unitId, ownerUserId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Unit not found");
    return this.mapUnit(row);
  }

  private requireRentSchedule(ownerUserId: string, scheduleId: string): PropertyRentSchedule {
    const row = this.db.prepare(`
      SELECT s.*, p.name AS property_name FROM property_rent_schedules s
      JOIN managed_properties p ON p.id = s.property_id
      WHERE s.id = ? AND p.owner_user_id = ?
    `).get(scheduleId, ownerUserId) as Row | undefined;
    if (!row) throw new PropertyPlatformNotFoundError("Rent schedule not found");
    return mapRentSchedule(row);
  }

  private insertLedgerEntry(input: {
    organizationId: string;
    propertyId: string;
    leaseId: string | null;
    chargeId: string | null;
    paymentId: string | null;
    entryType: PropertyLedgerEntry["entryType"];
    amountCents: number;
    description: string;
    effectiveAt: string;
    uniqueKey: string | null;
  }): PropertyLedgerEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO property_ledger_entries (
        id, organization_id, property_id, lease_id, charge_id, payment_id, entry_type,
        amount_cents, description, effective_at, unique_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.organizationId,
      input.propertyId,
      input.leaseId,
      input.chargeId,
      input.paymentId,
      input.entryType,
      input.amountCents,
      input.description,
      input.effectiveAt,
      input.uniqueKey,
      now
    );
    const row = input.uniqueKey
      ? this.db.prepare("SELECT * FROM property_ledger_entries WHERE unique_key = ?").get(input.uniqueKey) as Row
      : this.db.prepare("SELECT * FROM property_ledger_entries WHERE id = ?").get(id) as Row;
    return mapLedgerEntry(row);
  }

  private ensureReceipt(payment: {
    id: string;
    amountCents: number;
    paidAt: string | null;
  }): PropertyReceipt {
    let row = this.db.prepare("SELECT * FROM property_receipts WHERE payment_id = ?").get(payment.id) as Row | undefined;
    if (!row) {
      const now = new Date();
      const receiptNumber = `RENT-${now.getUTCFullYear()}-${String(
        Number((this.db.prepare("SELECT COUNT(*) AS count FROM property_receipts").get() as Row).count) + 1
      ).padStart(6, "0")}`;
      this.db.prepare(`
        INSERT INTO property_receipts (
          id, payment_id, receipt_number, amount_cents, currency, paid_at, created_at
        ) VALUES (?, ?, ?, ?, 'USD', ?, ?)
      `).run(
        randomUUID(),
        payment.id,
        receiptNumber,
        payment.amountCents,
        payment.paidAt ?? now.toISOString(),
        now.toISOString()
      );
      row = this.db.prepare("SELECT * FROM property_receipts WHERE payment_id = ?").get(payment.id) as Row;
    }
    return mapReceipt(row);
  }

  private invitationByToken(token: string): Row {
    const row = this.db.prepare(invitationSelect("i.token_hash = ?")).get(tokenHash(token)) as Row | undefined;
    if (!row) throw new PropertyInvitationError("Invitation not found");
    return row;
  }

  private mapInvitation(row: Row, invitationUrl: string | null): PropertyTenantInvitation {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      tenantName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
      email: String(row.email),
      expiresAt: String(row.expires_at),
      acceptedAt: optionalString(row.accepted_at),
      createdAt: String(row.created_at),
      invitationUrl
    };
  }

  private mapUnit(row: Row): PropertyUnit {
    const propertyName = optionalString(row.property_name)
      ?? String((this.db.prepare("SELECT name FROM managed_properties WHERE id = ?").get(row.property_id) as Row).name);
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      propertyId: String(row.property_id),
      propertyName,
      name: String(row.name),
      bedrooms: nullableNumber(row.bedrooms),
      bathrooms: nullableNumber(row.bathrooms),
      monthlyRentCents: nullableNumber(row.monthly_rent_cents),
      status: row.status as PropertyUnit["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRequestComment(row: Row): PropertyRequestComment {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      authorUserId: String(row.author_user_id),
      authorName: String(row.author_name),
      body: String(row.body),
      tenantVisible: Boolean(row.tenant_visible),
      createdAt: String(row.created_at)
    };
  }

  private mapRequestAttachment(row: Row): PropertyRequestAttachment {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      filename: String(row.filename),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      createdAt: String(row.created_at)
    };
  }

  private mapConsent(row: Row): PropertyCommunicationConsent {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      channel: row.channel as "email" | "sms",
      destination: String(row.destination),
      status: row.status as "opted_in" | "opted_out",
      source: String(row.source),
      consentedAt: optionalString(row.consented_at),
      revokedAt: optionalString(row.revoked_at),
      updatedAt: String(row.updated_at)
    };
  }
}

function invitationSelect(where: string): string {
  return `
    SELECT i.*, t.first_name, t.last_name, o.name AS organization_name
    FROM property_tenant_invitations i
    JOIN property_tenants t ON t.id = i.tenant_id
    JOIN property_organizations o ON o.id = i.organization_id
    WHERE ${where}
  `;
}

function mapOrganization(row: Row): PropertyOrganization {
  return {
    id: String(row.id),
    name: String(row.name),
    ownerUserId: String(row.owner_user_id),
    timezone: String(row.timezone),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapMembership(row: Row): PropertyOrganizationMember {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    role: row.role as PropertyOrganizationMember["role"],
    createdAt: String(row.created_at)
  };
}

function mapDocumentVersion(row: Row): PropertyDocumentVersion {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    version: Number(row.version),
    filename: String(row.filename),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    createdAt: String(row.created_at)
  };
}

function mapStatusEvent(row: Row): PropertyRequestStatusEvent {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    fromStatus: row.from_status ? row.from_status as PropertyServiceRequestStatus : null,
    toStatus: row.to_status as PropertyServiceRequestStatus,
    actorUserId: String(row.actor_user_id),
    createdAt: String(row.created_at)
  };
}

function mapRentSchedule(row: Row): PropertyRentSchedule {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    propertyId: String(row.property_id),
    propertyName: String(row.property_name),
    leaseId: String(row.lease_id),
    amountCents: Number(row.amount_cents),
    dueDay: Number(row.due_day),
    descriptionTemplate: String(row.description_template),
    nextChargeDate: String(row.next_charge_date),
    reminderDays: parseNumberArray(row.reminder_days_json),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapLedgerEntry(row: Row): PropertyLedgerEntry {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    propertyId: String(row.property_id),
    leaseId: optionalString(row.lease_id),
    chargeId: optionalString(row.charge_id),
    paymentId: optionalString(row.payment_id),
    entryType: row.entry_type as PropertyLedgerEntry["entryType"],
    amountCents: Number(row.amount_cents),
    description: String(row.description),
    effectiveAt: String(row.effective_at),
    createdAt: String(row.created_at)
  };
}

function mapReceipt(row: Row): PropertyReceipt {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    receiptNumber: String(row.receipt_number),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    paidAt: String(row.paid_at),
    createdAt: String(row.created_at)
  };
}

function mapNotificationJob(row: Row): PropertyNotificationJob {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    tenantId: optionalString(row.tenant_id),
    chargeId: optionalString(row.charge_id),
    channel: row.channel as PropertyNotificationChannel,
    recipient: String(row.recipient),
    subject: String(row.subject),
    body: String(row.body),
    scheduledAt: String(row.scheduled_at),
    status: row.status as PropertyNotificationJob["status"],
    attempts: Number(row.attempts),
    lastError: optionalString(row.last_error),
    completedAt: optionalString(row.completed_at),
    createdAt: String(row.created_at)
  };
}

function mapDeliveryAttempt(row: Row): PropertyDeliveryAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    provider: String(row.provider),
    providerId: optionalString(row.provider_id),
    status: row.status as PropertyDeliveryAttempt["status"],
    error: optionalString(row.error),
    createdAt: String(row.created_at)
  };
}

function emptyOverview(integrations: PropertyIntegrationSettings): PropertyPlatformOverview {
  return {
    organizations: [],
    memberships: [],
    units: [],
    invitations: [],
    documents: [],
    requestComments: [],
    requestStatusHistory: [],
    requestAttachments: [],
    rentSchedules: [],
    ledgerEntries: [],
    receipts: [],
    notificationJobs: [],
    deliveryAttempts: [],
    consents: [],
    integrations,
    report: emptyReport()
  };
}

function emptyReport(): PropertyOperationsReport {
  return {
    generatedAt: new Date().toISOString(),
    totalChargesCents: 0,
    totalPaymentsCents: 0,
    totalAdjustmentsCents: 0,
    outstandingCents: 0,
    overdueCharges: 0,
    openRequests: 0,
    expiringLeases: 0,
    queuedNotifications: 0
  };
}

function tenantReport(
  ledger: PropertyLedgerEntry[],
  requestCount: number,
  jobs: PropertyNotificationJob[]
): PropertyOperationsReport {
  return {
    generatedAt: new Date().toISOString(),
    totalChargesCents: ledger.filter((entry) => entry.entryType === "charge")
      .reduce((total, entry) => total + entry.amountCents, 0),
    totalPaymentsCents: ledger.filter((entry) => entry.entryType === "payment")
      .reduce((total, entry) => total - entry.amountCents, 0),
    totalAdjustmentsCents: ledger.filter((entry) => ["adjustment", "refund"].includes(entry.entryType))
      .reduce((total, entry) => total + entry.amountCents, 0),
    outstandingCents: ledger.reduce((total, entry) => total + entry.amountCents, 0),
    overdueCharges: 0,
    openRequests: requestCount,
    expiringLeases: 0,
    queuedNotifications: jobs.filter((job) => ["queued", "running"].includes(job.status)).length
  };
}

function hiddenIntegrations(settings: PropertyIntegrationSettings): PropertyIntegrationSettings {
  return {
    stripeConfigured: false,
    stripeSource: "none",
    stripeWebhookConfigured: false,
    paypalConfigured: false,
    paypalSource: "none",
    paypalEnvironment: settings.paypalEnvironment,
    paypalWebhookConfigured: false,
    zelleRecipient: null,
    twilioConfigured: false,
    twilioSource: "none",
    gmailConnectionId: null
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseNumberArray(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : [];
  } catch {
    return [];
  }
}

function addMonth(date: string): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

function offsetDateTime(date: string, offsetDays: number): string {
  const value = new Date(`${date}T13:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString();
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
