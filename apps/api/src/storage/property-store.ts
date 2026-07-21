import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";
import type {
  ManagedProperty,
  ManagedPropertyCreate,
  ManagedPropertyPatch,
  PropertyLease,
  PropertyLeaseCreate,
  PropertyPayment,
  PropertyPaymentConfiguration,
  PropertyPaymentCreate,
  PropertyPaymentPatch,
  PropertyPortfolioOverview,
  PropertyRentCharge,
  PropertyRentChargeCreate,
  PropertyServiceRequest,
  PropertyServiceRequestCreate,
  PropertyServiceRequestPatch,
  PropertyTenant,
  PropertyTenantCreate
} from "@email-client/shared";

type Row = Record<string, unknown>;

export interface SeedProperty extends ManagedPropertyCreate {
  imageFilename: string;
}

export interface PropertyPaymentGatewayUpdate {
  status?: PropertyPayment["status"];
  method?: PropertyPayment["method"];
  externalId?: string | null;
  providerTransactionId?: string | null;
  checkoutUrl?: string | null;
  reference?: string | null;
  paidAt?: string | null;
  failureReason?: string | null;
}

export class PropertyAccessError extends Error {}
export class PropertyNotFoundError extends Error {}

export class PropertyStore {
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

  hasOwnedProperties(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM managed_properties WHERE owner_user_id = ? LIMIT 1").get(userId));
  }

  seedDefaultProperties(ownerUserId: string, properties: SeedProperty[]): void {
    const existing = this.db.prepare(
      "SELECT COUNT(*) AS count FROM managed_properties WHERE owner_user_id = ?"
    ).get(ownerUserId) as Row;
    if (Number(existing.count ?? 0) > 0) return;
    const insert = this.db.transaction(() => {
      for (const property of properties) {
        this.createProperty(ownerUserId, property, property.imageFilename);
      }
    });
    insert();
  }

  overview(
    userId: string,
    paymentConfiguration: PropertyPaymentConfiguration
  ): PropertyPortfolioOverview {
    const mode = this.modeForUser(userId);
    const properties = this.listProperties(userId, mode);
    const propertyIds = new Set(properties.map((property) => property.id));
    const tenants = this.listTenants(userId, mode);
    const leases = this.listLeases(userId, mode).filter((lease) => propertyIds.has(lease.propertyId));
    const serviceRequests = this.listServiceRequests(userId, mode)
      .filter((request) => propertyIds.has(request.propertyId));
    const rentCharges = this.listRentCharges(userId, mode)
      .filter((charge) => propertyIds.has(charge.propertyId));
    const payments = this.listPayments(userId, mode)
      .filter((payment) => propertyIds.has(payment.propertyId));
    const month = new Date().toISOString().slice(0, 7);
    return {
      mode,
      generatedAt: new Date().toISOString(),
      stats: {
        propertyCount: properties.length,
        occupiedCount: properties.filter((property) => property.status === "occupied").length,
        openRequestCount: serviceRequests.filter((request) => !["completed", "cancelled"].includes(request.status)).length,
        outstandingBalanceCents: rentCharges.reduce((total, charge) => total + charge.balanceCents, 0),
        paidThisMonthCents: payments
          .filter((payment) => payment.status === "succeeded" && payment.paidAt?.startsWith(month))
          .reduce((total, payment) => total + payment.amountCents, 0)
      },
      properties,
      tenants,
      leases,
      serviceRequests,
      rentCharges,
      payments,
      paymentConfiguration
    };
  }

  createProperty(ownerUserId: string, input: ManagedPropertyCreate, imageFilename: string | null = null): ManagedProperty {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO managed_properties (
        id, owner_user_id, name, address_line1, address_line2, city, state, postal_code,
        property_type, status, image_filename, bedrooms, bathrooms, monthly_rent_cents,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ownerUserId,
      input.name,
      input.addressLine1,
      input.addressLine2,
      input.city,
      input.state,
      input.postalCode,
      input.propertyType,
      input.status,
      imageFilename,
      input.bedrooms,
      input.bathrooms,
      input.monthlyRentCents,
      input.notes,
      now,
      now
    );
    return this.requireProperty(ownerUserId, id);
  }

  updateProperty(userId: string, propertyId: string, input: ManagedPropertyPatch): ManagedProperty {
    this.requireOwnedProperty(userId, propertyId);
    const fields = new Map<keyof ManagedPropertyPatch, string>([
      ["name", "name"],
      ["addressLine1", "address_line1"],
      ["addressLine2", "address_line2"],
      ["city", "city"],
      ["state", "state"],
      ["postalCode", "postal_code"],
      ["propertyType", "property_type"],
      ["status", "status"],
      ["bedrooms", "bedrooms"],
      ["bathrooms", "bathrooms"],
      ["monthlyRentCents", "monthly_rent_cents"],
      ["notes", "notes"]
    ]);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(input[key]);
      }
    }
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString(), propertyId, userId);
    this.db.prepare(`
      UPDATE managed_properties SET ${assignments.join(", ")}
      WHERE id = ? AND owner_user_id = ?
    `).run(...values);
    return this.requireProperty(userId, propertyId);
  }

  setPropertyImage(userId: string, propertyId: string, imageFilename: string): ManagedProperty {
    this.requireOwnedProperty(userId, propertyId);
    this.db.prepare(`
      UPDATE managed_properties SET image_filename = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
    `).run(imageFilename, new Date().toISOString(), propertyId, userId);
    return this.requireProperty(userId, propertyId);
  }

  assertOwnedProperty(userId: string, propertyId: string): void {
    this.requireOwnedProperty(userId, propertyId);
  }

  propertyImage(userId: string, propertyId: string): { filename: string } | null {
    if (!this.canAccessProperty(userId, propertyId)) throw new PropertyNotFoundError("Property not found");
    const row = this.db.prepare("SELECT image_filename FROM managed_properties WHERE id = ?")
      .get(propertyId) as Row | undefined;
    return row?.image_filename ? { filename: String(row.image_filename) } : null;
  }

  createTenant(ownerUserId: string, input: PropertyTenantCreate): PropertyTenant {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_tenants (
        id, owner_user_id, linked_user_id, first_name, last_name, email, phone, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ownerUserId,
      input.linkedUserId,
      input.firstName,
      input.lastName,
      input.email.toLowerCase(),
      input.phone,
      input.status,
      now,
      now
    );
    return this.requireTenant(ownerUserId, id);
  }

  createLease(ownerUserId: string, input: PropertyLeaseCreate): PropertyLease {
    this.requireOwnedProperty(ownerUserId, input.propertyId);
    this.requireTenant(ownerUserId, input.tenantId);
    const unitId = input.unitId ?? this.defaultUnitId(ownerUserId, input.propertyId);
    if (unitId) {
      const unit = this.db.prepare(`
        SELECT u.id FROM property_units u
        JOIN managed_properties p ON p.id = u.property_id
        WHERE u.id = ? AND u.property_id = ? AND p.owner_user_id = ?
      `).get(unitId, input.propertyId, ownerUserId);
      if (!unit) throw new PropertyAccessError("Unit does not belong to this property");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_leases (
        id, owner_user_id, property_id, unit_id, tenant_id, start_date, end_date, monthly_rent_cents,
        security_deposit_cents, due_day, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ownerUserId,
      input.propertyId,
      unitId,
      input.tenantId,
      input.startDate,
      input.endDate,
      input.monthlyRentCents,
      input.securityDepositCents,
      input.dueDay,
      input.status,
      now,
      now
    );
    this.db.prepare(`
      UPDATE managed_properties
      SET status = CASE WHEN ? = 'active' THEN 'occupied' ELSE status END,
          monthly_rent_cents = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
    `).run(input.status, input.monthlyRentCents, now, input.propertyId, ownerUserId);
    return this.requireLease(ownerUserId, id);
  }

  createServiceRequest(userId: string, input: PropertyServiceRequestCreate): PropertyServiceRequest {
    const property = this.accessiblePropertyRow(userId, input.propertyId);
    const mode = this.modeForUser(userId);
    let tenantId = input.tenantId;
    if (mode === "tenant") {
      const linkedTenant = this.linkedTenantForProperty(userId, input.propertyId);
      tenantId = linkedTenant ? String(linkedTenant.id) : null;
      if (!tenantId) throw new PropertyAccessError("This tenant is not assigned to the property");
    } else if (tenantId) {
      this.requireTenant(String(property.owner_user_id), tenantId);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_service_requests (
        id, owner_user_id, property_id, tenant_id, title, description, category, priority,
        status, preferred_entry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)
    `).run(
      id,
      property.owner_user_id,
      input.propertyId,
      tenantId,
      input.title,
      input.description,
      input.category,
      input.priority,
      input.preferredEntryAt,
      now,
      now
    );
    return this.requireServiceRequest(userId, id);
  }

  updateServiceRequest(
    userId: string,
    requestId: string,
    input: PropertyServiceRequestPatch
  ): PropertyServiceRequest {
    const row = this.serviceRequestRowForUser(userId, requestId);
    if (!row) throw new PropertyNotFoundError("Service request not found");
    if (String(row.owner_user_id) !== userId) {
      throw new PropertyAccessError("Tenants cannot change request workflow fields");
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.priority !== undefined) {
      assignments.push("priority = ?");
      values.push(input.priority);
    }
    if (input.status !== undefined) {
      assignments.push("status = ?");
      values.push(input.status);
    }
    if (input.preferredEntryAt !== undefined) {
      assignments.push("preferred_entry_at = ?");
      values.push(input.preferredEntryAt);
    }
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString(), requestId, userId);
    this.db.prepare(`
      UPDATE property_service_requests SET ${assignments.join(", ")}
      WHERE id = ? AND owner_user_id = ?
    `).run(...values);
    return this.requireServiceRequest(userId, requestId);
  }

  createRentCharge(ownerUserId: string, input: PropertyRentChargeCreate): PropertyRentCharge {
    this.requireOwnedProperty(ownerUserId, input.propertyId);
    if (input.leaseId) {
      const lease = this.requireLease(ownerUserId, input.leaseId);
      if (lease.propertyId !== input.propertyId) throw new PropertyAccessError("Lease belongs to another property");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO property_rent_charges (
        id, owner_user_id, property_id, lease_id, description, amount_cents, due_date,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      ownerUserId,
      input.propertyId,
      input.leaseId,
      input.description,
      input.amountCents,
      input.dueDate,
      now,
      now
    );
    return this.requireRentCharge(ownerUserId, id);
  }

  createPayment(userId: string, input: PropertyPaymentCreate): PropertyPayment {
    const property = this.accessiblePropertyRow(userId, input.propertyId);
    let leaseId = input.leaseId;
    const mode = this.modeForUser(userId);
    if (mode === "tenant" && input.status !== "pending") {
      throw new PropertyAccessError("Tenant payments must be verified before their status can change");
    }
    if (mode === "tenant" && !leaseId) {
      const lease = this.db.prepare(`
        SELECT l.id FROM property_leases l
        JOIN property_tenants t ON t.id = l.tenant_id
        WHERE l.property_id = ? AND t.linked_user_id = ?
        ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END, l.updated_at DESC
        LIMIT 1
      `).get(input.propertyId, userId) as Row | undefined;
      leaseId = lease ? String(lease.id) : null;
      if (!leaseId) throw new PropertyAccessError("No lease is linked to this tenant and property");
    }
    if (leaseId) {
      const lease = this.requireLease(userId, leaseId);
      if (lease.propertyId !== input.propertyId) throw new PropertyAccessError("Lease belongs to another property");
    }
    if (input.chargeId) {
      const charge = this.requireRentCharge(userId, input.chargeId);
      if (charge.propertyId !== input.propertyId) throw new PropertyAccessError("Rent charge belongs to another property");
      if (!leaseId && charge.leaseId) leaseId = charge.leaseId;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const paidAt = input.status === "succeeded" ? input.paidAt ?? now : input.paidAt;
    this.db.prepare(`
      INSERT INTO property_payments (
        id, owner_user_id, property_id, lease_id, charge_id, provider, method, amount_cents,
        currency, status, external_id, checkout_url, reference, paid_at, failure_reason,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      property.owner_user_id,
      input.propertyId,
      leaseId,
      input.chargeId,
      input.provider,
      input.method,
      input.amountCents,
      input.currency.toUpperCase(),
      input.status,
      input.reference,
      paidAt,
      input.notes,
      now,
      now
    );
    this.recordPaymentEvent(id, "created", input.status, null, { provider: input.provider, method: input.method });
    return this.requirePayment(userId, id);
  }

  updatePayment(userId: string, paymentId: string, input: PropertyPaymentPatch): PropertyPayment {
    const payment = this.requirePayment(userId, paymentId);
    if (this.modeForUser(userId) === "tenant") {
      throw new PropertyAccessError("Only the property manager can change payment status");
    }
    const paidAt = input.status === "succeeded" ? input.paidAt ?? payment.paidAt ?? new Date().toISOString() : input.paidAt;
    this.db.prepare(`
      UPDATE property_payments
      SET status = ?, reference = COALESCE(?, reference), paid_at = ?,
          failure_reason = ?, notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.reference,
      paidAt,
      input.failureReason,
      input.notes,
      new Date().toISOString(),
      paymentId
    );
    this.recordPaymentEvent(paymentId, "status_updated", input.status, payment.externalId, input);
    return this.requirePayment(userId, paymentId);
  }

  updatePaymentGateway(
    userId: string,
    paymentId: string,
    input: PropertyPaymentGatewayUpdate,
    eventType = "gateway_synced",
    details: unknown = input
  ): PropertyPayment {
    const payment = this.requirePayment(userId, paymentId);
    const nextStatus = input.status ?? payment.status;
    const paidAt = nextStatus === "succeeded"
      ? input.paidAt ?? payment.paidAt ?? new Date().toISOString()
      : input.paidAt === undefined ? payment.paidAt : input.paidAt;
    this.db.prepare(`
      UPDATE property_payments
      SET status = ?, method = ?, external_id = ?, provider_transaction_id = ?, checkout_url = ?, reference = ?,
          paid_at = ?, failure_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      input.method ?? payment.method,
      input.externalId === undefined ? payment.externalId : input.externalId,
      input.providerTransactionId === undefined ? payment.providerTransactionId : input.providerTransactionId,
      input.checkoutUrl === undefined ? payment.checkoutUrl : input.checkoutUrl,
      input.reference === undefined ? payment.reference : input.reference,
      paidAt,
      input.failureReason === undefined ? payment.failureReason : input.failureReason,
      new Date().toISOString(),
      paymentId
    );
    this.recordPaymentEvent(paymentId, eventType, nextStatus, input.externalId ?? payment.externalId, details);
    return this.requirePayment(userId, paymentId);
  }

  getPayment(userId: string, paymentId: string): PropertyPayment {
    return this.requirePayment(userId, paymentId);
  }

  getPaymentWithOwner(paymentId: string): { ownerUserId: string; payment: PropertyPayment } {
    const row = this.paymentRowBy("pay.id = ?", paymentId);
    if (!row) throw new PropertyNotFoundError("Payment not found");
    return { ownerUserId: String(row.owner_user_id), payment: this.mapPayment(row) };
  }

  findPaymentByProviderReference(provider: PropertyPayment["provider"], reference: string): PropertyPayment | null {
    const row = this.paymentRowBy(
      "pay.provider = ? AND (pay.external_id = ? OR pay.provider_transaction_id = ?)",
      provider,
      reference,
      reference
    );
    return row ? this.mapPayment(row) : null;
  }

  updatePaymentGatewaySystem(
    paymentId: string,
    input: PropertyPaymentGatewayUpdate,
    eventType: string,
    details: unknown
  ): PropertyPayment {
    const current = this.getPaymentWithOwner(paymentId);
    return this.updatePaymentGateway(current.ownerUserId, paymentId, input, eventType, details);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_properties (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        address_line1 TEXT NOT NULL,
        address_line2 TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        property_type TEXT NOT NULL,
        status TEXT NOT NULL,
        image_filename TEXT,
        bedrooms REAL,
        bathrooms REAL,
        monthly_rent_cents INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_tenants (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        linked_user_id TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_leases (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        unit_id TEXT,
        tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE RESTRICT,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        monthly_rent_cents INTEGER NOT NULL,
        security_deposit_cents INTEGER NOT NULL DEFAULT 0,
        due_day INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_service_requests (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        preferred_entry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_rent_charges (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_payments (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,
        lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,
        charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        external_id TEXT,
        provider_transaction_id TEXT,
        checkout_url TEXT,
        reference TEXT,
        paid_at TEXT,
        failure_reason TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS property_payment_events (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES property_payments(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        external_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS managed_properties_owner_idx
        ON managed_properties(owner_user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS property_tenants_owner_idx
        ON property_tenants(owner_user_id, status, last_name, first_name);
      CREATE INDEX IF NOT EXISTS property_tenants_linked_user_idx
        ON property_tenants(linked_user_id, status);
      CREATE INDEX IF NOT EXISTS property_leases_owner_idx
        ON property_leases(owner_user_id, status, end_date);
      CREATE INDEX IF NOT EXISTS property_leases_property_idx
        ON property_leases(property_id, status);
      CREATE INDEX IF NOT EXISTS property_requests_owner_idx
        ON property_service_requests(owner_user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS property_charges_owner_idx
        ON property_rent_charges(owner_user_id, due_date DESC);
      CREATE INDEX IF NOT EXISTS property_payments_owner_idx
        ON property_payments(owner_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS property_payments_charge_idx
        ON property_payments(charge_id, status);
      CREATE INDEX IF NOT EXISTS property_payment_events_payment_idx
        ON property_payment_events(payment_id, created_at DESC);
    `);
    const paymentColumns = this.db.prepare("PRAGMA table_info(property_payments)").all() as Row[];
    if (!paymentColumns.some((row) => row.name === "provider_transaction_id")) {
      this.db.exec("ALTER TABLE property_payments ADD COLUMN provider_transaction_id TEXT");
    }
    const leaseColumns = this.db.prepare("PRAGMA table_info(property_leases)").all() as Row[];
    if (!leaseColumns.some((row) => row.name === "unit_id")) {
      this.db.exec("ALTER TABLE property_leases ADD COLUMN unit_id TEXT");
    }
  }

  private modeForUser(userId: string): "manager" | "tenant" {
    const owned = this.db.prepare("SELECT 1 FROM managed_properties WHERE owner_user_id = ? LIMIT 1")
      .get(userId);
    if (owned) return "manager";
    const linked = this.db.prepare("SELECT 1 FROM property_tenants WHERE linked_user_id = ? LIMIT 1")
      .get(userId);
    return linked ? "tenant" : "manager";
  }

  private listProperties(userId: string, mode: "manager" | "tenant"): ManagedProperty[] {
    const rows = mode === "manager"
      ? this.db.prepare("SELECT * FROM managed_properties WHERE owner_user_id = ? ORDER BY name COLLATE NOCASE").all(userId)
      : this.db.prepare(`
          SELECT DISTINCT p.* FROM managed_properties p
          JOIN property_leases l ON l.property_id = p.id
          JOIN property_tenants t ON t.id = l.tenant_id
          WHERE t.linked_user_id = ?
          ORDER BY p.name COLLATE NOCASE
        `).all(userId);
    const leases = this.listLeases(userId, mode);
    const requests = this.listServiceRequests(userId, mode);
    const charges = this.listRentCharges(userId, mode);
    return (rows as Row[]).map((row) => {
      const activeLease = leases.find((lease) => lease.propertyId === String(row.id) && lease.status === "active");
      return this.mapProperty(
        row,
        activeLease?.tenantName ?? null,
        activeLease?.endDate ?? null,
        requests.filter((request) => request.propertyId === String(row.id)
          && !["completed", "cancelled"].includes(request.status)).length,
        charges.filter((charge) => charge.propertyId === String(row.id))
          .reduce((total, charge) => total + charge.balanceCents, 0)
      );
    });
  }

  private listTenants(userId: string, mode: "manager" | "tenant"): PropertyTenant[] {
    const rows = mode === "manager"
      ? this.db.prepare("SELECT * FROM property_tenants WHERE owner_user_id = ? ORDER BY last_name, first_name").all(userId)
      : this.db.prepare("SELECT * FROM property_tenants WHERE linked_user_id = ? ORDER BY last_name, first_name").all(userId);
    return (rows as Row[]).map((row) => this.mapTenant(row));
  }

  private listLeases(userId: string, mode: "manager" | "tenant"): PropertyLease[] {
    const where = mode === "manager" ? "l.owner_user_id = ?" : "t.linked_user_id = ?";
    return (this.db.prepare(`
      SELECT l.*, p.name AS property_name, t.first_name, t.last_name
      FROM property_leases l
      JOIN managed_properties p ON p.id = l.property_id
      JOIN property_tenants t ON t.id = l.tenant_id
      WHERE ${where}
      ORDER BY l.end_date DESC, l.created_at DESC
    `).all(userId) as Row[]).map((row) => this.mapLease(row));
  }

  private listServiceRequests(userId: string, mode: "manager" | "tenant"): PropertyServiceRequest[] {
    const where = mode === "manager" ? "r.owner_user_id = ?" : "t.linked_user_id = ?";
    return (this.db.prepare(`
      SELECT r.*, p.name AS property_name, t.first_name, t.last_name
      FROM property_service_requests r
      JOIN managed_properties p ON p.id = r.property_id
      LEFT JOIN property_tenants t ON t.id = r.tenant_id
      WHERE ${where}
      ORDER BY
        CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        r.updated_at DESC
    `).all(userId) as Row[]).map((row) => this.mapServiceRequest(row));
  }

  private listRentCharges(userId: string, mode: "manager" | "tenant"): PropertyRentCharge[] {
    const where = mode === "manager" ? "c.owner_user_id = ?" : "t.linked_user_id = ?";
    return (this.db.prepare(`
      SELECT c.*, p.name AS property_name,
        COALESCE(SUM(CASE WHEN pay.status = 'succeeded' THEN pay.amount_cents ELSE 0 END), 0) AS paid_cents
      FROM property_rent_charges c
      JOIN managed_properties p ON p.id = c.property_id
      LEFT JOIN property_leases l ON l.id = c.lease_id
      LEFT JOIN property_tenants t ON t.id = l.tenant_id
      LEFT JOIN property_payments pay ON pay.charge_id = c.id
      WHERE ${where}
      GROUP BY c.id
      ORDER BY c.due_date DESC, c.created_at DESC
    `).all(userId) as Row[]).map((row) => this.mapRentCharge(row));
  }

  private listPayments(userId: string, mode: "manager" | "tenant"): PropertyPayment[] {
    const where = mode === "manager" ? "pay.owner_user_id = ?" : "t.linked_user_id = ?";
    return (this.db.prepare(`
      SELECT pay.*, p.name AS property_name
      FROM property_payments pay
      JOIN managed_properties p ON p.id = pay.property_id
      LEFT JOIN property_leases l ON l.id = pay.lease_id
      LEFT JOIN property_tenants t ON t.id = l.tenant_id
      WHERE ${where}
      ORDER BY pay.created_at DESC
    `).all(userId) as Row[]).map((row) => this.mapPayment(row));
  }

  private requireProperty(userId: string, propertyId: string): ManagedProperty {
    const row = this.accessiblePropertyRow(userId, propertyId);
    const mode = this.modeForUser(userId);
    return this.listProperties(userId, mode).find((property) => property.id === String(row.id))!;
  }

  private requireOwnedProperty(userId: string, propertyId: string): Row {
    const row = this.db.prepare("SELECT * FROM managed_properties WHERE id = ? AND owner_user_id = ?")
      .get(propertyId, userId) as Row | undefined;
    if (!row) throw new PropertyNotFoundError("Property not found");
    return row;
  }

  private accessiblePropertyRow(userId: string, propertyId: string): Row {
    const row = this.db.prepare(`
      SELECT p.* FROM managed_properties p
      WHERE p.id = ? AND (
        p.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM property_leases l
          JOIN property_tenants t ON t.id = l.tenant_id
          WHERE l.property_id = p.id AND t.linked_user_id = ?
        )
      )
    `).get(propertyId, userId, userId) as Row | undefined;
    if (!row) throw new PropertyNotFoundError("Property not found");
    return row;
  }

  private canAccessProperty(userId: string, propertyId: string): boolean {
    try {
      this.accessiblePropertyRow(userId, propertyId);
      return true;
    } catch {
      return false;
    }
  }

  private linkedTenantForProperty(userId: string, propertyId: string): Row | undefined {
    return this.db.prepare(`
      SELECT t.* FROM property_tenants t
      JOIN property_leases l ON l.tenant_id = t.id
      WHERE t.linked_user_id = ? AND l.property_id = ?
      ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END, l.updated_at DESC
      LIMIT 1
    `).get(userId, propertyId) as Row | undefined;
  }

  private requireTenant(ownerUserId: string, tenantId: string): PropertyTenant {
    const row = this.db.prepare("SELECT * FROM property_tenants WHERE id = ? AND owner_user_id = ?")
      .get(tenantId, ownerUserId) as Row | undefined;
    if (!row) throw new PropertyNotFoundError("Tenant not found");
    return this.mapTenant(row);
  }

  private requireLease(userId: string, leaseId: string): PropertyLease {
    const lease = this.listLeases(userId, this.modeForUser(userId)).find((item) => item.id === leaseId);
    if (!lease) throw new PropertyNotFoundError("Lease not found");
    return lease;
  }

  private canAccessLease(userId: string, leaseId: string): boolean {
    return Boolean(this.listLeases(userId, this.modeForUser(userId)).find((lease) => lease.id === leaseId));
  }

  private requireServiceRequest(userId: string, requestId: string): PropertyServiceRequest {
    const row = this.serviceRequestRowForUser(userId, requestId);
    if (!row) throw new PropertyNotFoundError("Service request not found");
    return this.mapServiceRequest(row);
  }

  private serviceRequestRowForUser(userId: string, requestId: string): Row | undefined {
    return this.db.prepare(`
      SELECT r.*, p.name AS property_name, t.first_name, t.last_name
      FROM property_service_requests r
      JOIN managed_properties p ON p.id = r.property_id
      LEFT JOIN property_tenants t ON t.id = r.tenant_id
      WHERE r.id = ? AND (
        r.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM property_tenants linked
          WHERE linked.id = r.tenant_id AND linked.linked_user_id = ?
        )
      )
    `).get(requestId, userId, userId) as Row | undefined;
  }

  private requireRentCharge(userId: string, chargeId: string): PropertyRentCharge {
    const charge = this.listRentCharges(userId, this.modeForUser(userId)).find((item) => item.id === chargeId);
    if (!charge) throw new PropertyNotFoundError("Rent charge not found");
    return charge;
  }

  private canAccessCharge(userId: string, chargeId: string): boolean {
    return Boolean(this.listRentCharges(userId, this.modeForUser(userId)).find((charge) => charge.id === chargeId));
  }

  private requirePayment(userId: string, paymentId: string): PropertyPayment {
    const payment = this.listPayments(userId, this.modeForUser(userId)).find((item) => item.id === paymentId);
    if (!payment) throw new PropertyNotFoundError("Payment not found");
    return payment;
  }

  private recordPaymentEvent(
    paymentId: string,
    eventType: string,
    status: PropertyPayment["status"],
    externalId: string | null,
    details: unknown
  ): void {
    this.db.prepare(`
      INSERT INTO property_payment_events (
        id, payment_id, event_type, status, external_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      paymentId,
      eventType,
      status,
      externalId,
      details === undefined ? null : JSON.stringify(details),
      new Date().toISOString()
    );
  }

  private mapProperty(
    row: Row,
    tenantName: string | null,
    leaseEndDate: string | null,
    openRequestCount: number,
    outstandingBalanceCents: number
  ): ManagedProperty {
    return {
      id: String(row.id),
      name: String(row.name),
      addressLine1: String(row.address_line1),
      addressLine2: String(row.address_line2 ?? ""),
      city: String(row.city),
      state: String(row.state),
      postalCode: String(row.postal_code),
      propertyType: String(row.property_type) as ManagedProperty["propertyType"],
      status: String(row.status) as ManagedProperty["status"],
      imageUrl: row.image_filename ? `/api/properties/${String(row.id)}/photo` : null,
      bedrooms: row.bedrooms === null || row.bedrooms === undefined ? null : Number(row.bedrooms),
      bathrooms: row.bathrooms === null || row.bathrooms === undefined ? null : Number(row.bathrooms),
      monthlyRentCents: row.monthly_rent_cents === null || row.monthly_rent_cents === undefined
        ? null
        : Number(row.monthly_rent_cents),
      tenantName,
      leaseEndDate,
      openRequestCount,
      outstandingBalanceCents,
      notes: String(row.notes ?? ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapTenant(row: Row): PropertyTenant {
    const firstName = String(row.first_name);
    const lastName = String(row.last_name);
    return {
      id: String(row.id),
      linkedUserId: row.linked_user_id ? String(row.linked_user_id) : null,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`.trim(),
      email: String(row.email),
      phone: String(row.phone ?? ""),
      status: String(row.status) as PropertyTenant["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapLease(row: Row): PropertyLease {
    return {
      id: String(row.id),
      propertyId: String(row.property_id),
      unitId: row.unit_id ? String(row.unit_id) : null,
      tenantId: String(row.tenant_id),
      tenantName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
      propertyName: String(row.property_name),
      startDate: String(row.start_date),
      endDate: String(row.end_date),
      monthlyRentCents: Number(row.monthly_rent_cents),
      securityDepositCents: Number(row.security_deposit_cents),
      dueDay: Number(row.due_day),
      status: String(row.status) as PropertyLease["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private defaultUnitId(ownerUserId: string, propertyId: string): string | null {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'property_units'").get();
    if (!table) return null;
    const row = this.db.prepare(`
      SELECT u.id FROM property_units u
      JOIN managed_properties p ON p.id = u.property_id
      WHERE u.property_id = ? AND p.owner_user_id = ?
      ORDER BY u.created_at LIMIT 1
    `).get(propertyId, ownerUserId) as Row | undefined;
    return row ? String(row.id) : null;
  }

  private mapServiceRequest(row: Row): PropertyServiceRequest {
    const tenantName = row.first_name
      ? `${String(row.first_name)} ${String(row.last_name ?? "")}`.trim()
      : null;
    return {
      id: String(row.id),
      propertyId: String(row.property_id),
      tenantId: row.tenant_id ? String(row.tenant_id) : null,
      propertyName: String(row.property_name),
      tenantName,
      title: String(row.title),
      description: String(row.description),
      category: String(row.category),
      priority: String(row.priority) as PropertyServiceRequest["priority"],
      status: String(row.status) as PropertyServiceRequest["status"],
      preferredEntryAt: row.preferred_entry_at ? String(row.preferred_entry_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRentCharge(row: Row): PropertyRentCharge {
    const amountCents = Number(row.amount_cents);
    const paidCents = Math.min(amountCents, Number(row.paid_cents ?? 0));
    const balanceCents = Math.max(0, amountCents - paidCents);
    const storedStatus = String(row.status) as PropertyRentCharge["status"];
    const status = storedStatus === "void"
      ? "void"
      : balanceCents === 0
        ? "paid"
        : paidCents > 0
          ? "partially_paid"
          : String(row.due_date) < new Date().toISOString().slice(0, 10)
            ? "overdue"
            : "open";
    return {
      id: String(row.id),
      propertyId: String(row.property_id),
      leaseId: row.lease_id ? String(row.lease_id) : null,
      propertyName: String(row.property_name),
      description: String(row.description),
      amountCents,
      paidCents,
      balanceCents,
      dueDate: String(row.due_date),
      status,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapPayment(row: Row): PropertyPayment {
    return {
      id: String(row.id),
      propertyId: String(row.property_id),
      leaseId: row.lease_id ? String(row.lease_id) : null,
      chargeId: row.charge_id ? String(row.charge_id) : null,
      propertyName: String(row.property_name),
      provider: String(row.provider) as PropertyPayment["provider"],
      method: String(row.method) as PropertyPayment["method"],
      amountCents: Number(row.amount_cents),
      currency: String(row.currency),
      status: String(row.status) as PropertyPayment["status"],
      externalId: row.external_id ? String(row.external_id) : null,
      providerTransactionId: row.provider_transaction_id ? String(row.provider_transaction_id) : null,
      checkoutUrl: row.checkout_url ? String(row.checkout_url) : null,
      reference: row.reference ? String(row.reference) : null,
      paidAt: row.paid_at ? String(row.paid_at) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      notes: String(row.notes ?? ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private paymentRowBy(where: string, ...values: unknown[]): Row | undefined {
    return this.db.prepare(`
      SELECT pay.*, p.name AS property_name
      FROM property_payments pay
      JOIN managed_properties p ON p.id = pay.property_id
      WHERE ${where}
      ORDER BY pay.created_at DESC LIMIT 1
    `).get(...values) as Row | undefined;
  }
}
