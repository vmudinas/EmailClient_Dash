import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyAccessError, PropertyNotFoundError, PropertyStore } from "./property-store.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyStore", () => {
  it("isolates manager portfolios and gives linked tenants only their lease data", () => {
    const store = createStore();
    const managerId = randomUUID();
    const otherManagerId = randomUUID();
    const tenantUserId = randomUUID();
    const property = store.createProperty(managerId, propertyInput("Palm House"));
    store.createProperty(otherManagerId, propertyInput("Other House"));
    const tenant = store.createTenant(managerId, {
      linkedUserId: tenantUserId,
      firstName: "Taylor",
      lastName: "Tenant",
      email: "tenant@example.test",
      phone: "",
      status: "active"
    });
    const lease = store.createLease(managerId, {
      propertyId: property.id,
      tenantId: tenant.id,
      startDate: "2026-07-01",
      endDate: "2027-06-30",
      monthlyRentCents: 250_000,
      securityDepositCents: 250_000,
      dueDay: 1,
      status: "active"
    });
    store.createServiceRequest(tenantUserId, {
      propertyId: property.id,
      tenantId: null,
      title: "Air conditioning",
      description: "The system is not cooling.",
      category: "HVAC",
      priority: "high",
      preferredEntryAt: null
    });

    const configuration = paymentConfiguration();
    const tenantOverview = store.overview(tenantUserId, configuration);
    const managerOverview = store.overview(managerId, configuration);

    expect(tenantOverview.mode).toBe("tenant");
    expect(tenantOverview.properties.map((item) => item.name)).toEqual(["Palm House"]);
    expect(tenantOverview.leases[0]?.id).toBe(lease.id);
    expect(tenantOverview.serviceRequests[0]?.tenantId).toBe(tenant.id);
    expect(managerOverview.mode).toBe("manager");
    expect(managerOverview.stats.propertyCount).toBe(1);
    expect(() => store.propertyImage(otherManagerId, property.id)).toThrow(PropertyNotFoundError);
    store.close();
  });

  it("allocates successful payments to charges and derives balances", () => {
    const store = createStore();
    const managerId = randomUUID();
    const tenantUserId = randomUUID();
    const property = store.createProperty(managerId, propertyInput("Rent House"));
    const tenant = store.createTenant(managerId, {
      linkedUserId: tenantUserId,
      firstName: "Vitas",
      lastName: "Tenant",
      email: "vitas@example.test",
      phone: "",
      status: "active"
    });
    const lease = store.createLease(managerId, {
      propertyId: property.id,
      tenantId: tenant.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyRentCents: 200_000,
      securityDepositCents: 0,
      dueDay: 1,
      status: "active"
    });
    const charge = store.createRentCharge(managerId, {
      propertyId: property.id,
      leaseId: lease.id,
      description: "July rent",
      amountCents: 200_000,
      dueDate: "2026-07-01"
    });
    const payment = store.createPayment(tenantUserId, {
      propertyId: property.id,
      leaseId: null,
      chargeId: charge.id,
      provider: "stripe",
      method: "card",
      amountCents: 200_000,
      currency: "USD",
      status: "pending",
      reference: null,
      paidAt: null,
      notes: ""
    });
    store.updatePaymentGateway(managerId, payment.id, {
      status: "succeeded",
      paidAt: "2026-07-20T12:00:00.000Z",
      externalId: "cs_test_123"
    });

    const overview = store.overview(managerId, paymentConfiguration());
    expect(overview.rentCharges[0]).toMatchObject({
      id: charge.id,
      paidCents: 200_000,
      balanceCents: 0,
      status: "paid"
    });
    expect(overview.stats.paidThisMonthCents).toBe(200_000);
    expect(overview.payments[0]).toMatchObject({ status: "succeeded", externalId: "cs_test_123" });
    store.close();
  });

  it("requires provider or manager verification before a tenant payment can succeed", () => {
    const store = createStore();
    const managerId = randomUUID();
    const tenantUserId = randomUUID();
    const property = store.createProperty(managerId, propertyInput("Verified Rent House"));
    const tenant = store.createTenant(managerId, {
      linkedUserId: tenantUserId,
      firstName: "Taylor",
      lastName: "Tenant",
      email: "tenant@example.test",
      phone: "",
      status: "active"
    });
    const lease = store.createLease(managerId, {
      propertyId: property.id,
      tenantId: tenant.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyRentCents: 200_000,
      securityDepositCents: 0,
      dueDay: 1,
      status: "active"
    });

    expect(() => store.createPayment(tenantUserId, {
      propertyId: property.id,
      leaseId: lease.id,
      chargeId: null,
      provider: "manual",
      method: "cash",
      amountCents: 200_000,
      currency: "USD",
      status: "succeeded",
      reference: null,
      paidAt: "2026-07-20T12:00:00.000Z",
      notes: ""
    })).toThrow(PropertyAccessError);
    expect(store.overview(managerId, paymentConfiguration()).payments).toHaveLength(0);
    store.close();
  });

  it("seeds an owner's property list only once", () => {
    const store = createStore();
    const ownerId = randomUUID();
    const seeds = [{ ...propertyInput("Seed House"), imageFilename: "seed.jpg" }];
    store.seedDefaultProperties(ownerId, seeds);
    store.seedDefaultProperties(ownerId, seeds);
    expect(store.overview(ownerId, paymentConfiguration()).properties).toHaveLength(1);
    store.close();
  });
});

function createStore(): PropertyStore {
  const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-"));
  temporaryDirs.push(directory);
  return new PropertyStore(resolve(directory, "test.sqlite"));
}

function propertyInput(name: string) {
  return {
    name,
    addressLine1: "101 Test St",
    addressLine2: "",
    city: "Boca Raton",
    state: "FL",
    postalCode: "33486",
    propertyType: "single_family" as const,
    status: "setup" as const,
    bedrooms: null,
    bathrooms: null,
    monthlyRentCents: null,
    notes: ""
  };
}

function paymentConfiguration() {
  return {
    stripe: { configured: false, methods: ["card", "apple_pay", "google_pay", "ach"] as const },
    paypal: { configured: false, environment: "sandbox" as const, methods: ["paypal"] as const },
    zelle: { configured: false, recipient: null, note: "" },
    manual: { configured: true as const, methods: ["cash", "check", "other"] as const }
  };
}
