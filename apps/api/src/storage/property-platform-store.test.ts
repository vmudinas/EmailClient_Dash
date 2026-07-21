import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PropertyIntegrationSettings } from "@email-client/shared";
import { AuthService } from "../services/auth-service.js";
import { EmailDatabase } from "./database.js";
import {
  PropertyPlatformNotFoundError,
  PropertyPlatformStore
} from "./property-platform-store.js";
import { PropertyStore } from "./property-store.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyPlatformStore", () => {
  it("onboards a tenant and limits portal data to their unit, documents, and activity", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-platform-"));
    temporaryDirs.push(directory);
    const database = new EmailDatabase(directory);
    const auth = new AuthService(database, 60);
    auth.initialize();
    const managerId = database.listUsers()[0]!.id;
    const properties = new PropertyStore(database.path);
    const platform = new PropertyPlatformStore(database.path);
    const property = properties.createProperty(managerId, propertyInput());
    const unit = platform.syncProperty(managerId, property.id);
    const tenant = properties.createTenant(managerId, {
      linkedUserId: null,
      firstName: "Taylor",
      lastName: "Tenant",
      email: "tenant@example.test",
      phone: "+15615550101",
      status: "active"
    });
    const lease = properties.createLease(managerId, {
      propertyId: property.id,
      unitId: unit.id,
      tenantId: tenant.id,
      startDate: "2026-07-01",
      endDate: "2027-06-30",
      monthlyRentCents: 250_000,
      securityDepositCents: 250_000,
      dueDay: 1,
      status: "active"
    });
    const invitation = platform.createInvitation(managerId, tenant.id, 48, "https://rent.example.test");
    const token = new URL(invitation.invitationUrl!).searchParams.get("token")!;
    expect(platform.previewInvitation(token)).toMatchObject({
      email: "tenant@example.test",
      organizationName: "Vitas Property Management"
    });
    const tenantUser = auth.createInvitedUser({
      username: "taylor.tenant",
      displayName: "Taylor Tenant",
      password: "SecureTenant!2026"
    });
    platform.acceptInvitation(token, tenantUser.id);

    const request = properties.createServiceRequest(tenantUser.id, {
      propertyId: property.id,
      tenantId: null,
      title: "Air conditioning",
      description: "The system is not cooling.",
      category: "HVAC",
      priority: "high",
      preferredEntryAt: null
    });
    platform.recordRequestCreated(tenantUser.id, request.id);
    platform.addRequestComment(managerId, request.id, "Vendor scheduled for Tuesday.", true, "Manager");
    platform.addRequestComment(managerId, request.id, "Internal estimate is pending.", false, "Manager");

    const sharedDocument = platform.createDocument(managerId, {
      propertyId: property.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      title: "Signed lease",
      category: "Agreement",
      visibility: "tenant",
      requiresAcknowledgement: true
    }, storedFile("lease.pdf", "documents/lease.pdf"));
    const managerDocument = platform.createDocument(managerId, {
      propertyId: property.id,
      leaseId: null,
      tenantId: null,
      title: "Manager inspection notes",
      category: "Inspection",
      visibility: "manager",
      requiresAcknowledgement: false
    }, storedFile("inspection.txt", "documents/inspection.txt"));

    const charge = properties.createRentCharge(managerId, {
      propertyId: property.id,
      leaseId: lease.id,
      description: "August rent",
      amountCents: 250_000,
      dueDate: "2026-08-01"
    });
    platform.recordCharge(managerId, charge);
    expect(platform.enqueueChargeReminders(charge.id, [-3, 0])).toBe(4);
    expect(platform.enqueueProviderEvent("stripe", "evt_unique", "checkout.session.completed", {})).toBe(true);
    expect(platform.enqueueProviderEvent("stripe", "evt_unique", "checkout.session.completed", {})).toBe(false);

    const tenantOverview = platform.overview(tenantUser.id, configuredIntegrations());
    expect(tenantOverview.units).toEqual([expect.objectContaining({ id: unit.id })]);
    expect(tenantOverview.memberships).toEqual([expect.objectContaining({ userId: tenantUser.id, role: "tenant" })]);
    expect(tenantOverview.invitations).toEqual([]);
    expect(tenantOverview.documents.map((document) => document.title)).toEqual(["Signed lease"]);
    expect(tenantOverview.requestComments.map((comment) => comment.body)).toEqual(["Vendor scheduled for Tuesday."]);
    expect(tenantOverview.notificationJobs).toHaveLength(4);
    expect(tenantOverview.integrations).toMatchObject({
      stripeConfigured: false,
      paypalConfigured: false,
      twilioConfigured: false,
      gmailConnectionId: null
    });
    expect(() => platform.documentVersionForUser(tenantUser.id, managerDocument.latestVersion.id))
      .toThrow(PropertyPlatformNotFoundError);
    expect(platform.acknowledgeDocument(tenantUser.id, sharedDocument.id).acknowledgedAt).not.toBeNull();

    const managerOverview = platform.overview(managerId, configuredIntegrations());
    expect(managerOverview.documents).toHaveLength(2);
    expect(managerOverview.requestComments).toHaveLength(2);
    expect(managerOverview.invitations[0]?.acceptedAt).not.toBeNull();

    platform.close();
    properties.close();
    database.close();
  });
});

function propertyInput() {
  return {
    name: "Palm House",
    addressLine1: "101 Test St",
    addressLine2: "",
    city: "Boca Raton",
    state: "FL",
    postalCode: "33486",
    propertyType: "single_family" as const,
    status: "setup" as const,
    bedrooms: 3,
    bathrooms: 2,
    monthlyRentCents: 250_000,
    notes: ""
  };
}

function storedFile(filename: string, storageKey: string) {
  return {
    filename,
    contentType: filename.endsWith(".pdf") ? "application/pdf" : "text/plain",
    sizeBytes: 128,
    sha256: "a".repeat(64),
    storageKey
  };
}

function configuredIntegrations(): PropertyIntegrationSettings {
  return {
    stripeConfigured: true,
    stripeSource: "environment",
    stripeWebhookConfigured: true,
    paypalConfigured: true,
    paypalSource: "admin",
    paypalEnvironment: "live",
    paypalWebhookConfigured: true,
    zelleRecipient: "rent@example.test",
    twilioConfigured: true,
    twilioSource: "admin",
    gmailConnectionId: "13b0f948-f75b-4fa5-9a62-0313028c98c4"
  };
}
