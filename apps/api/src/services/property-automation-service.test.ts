import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth-service.js";
import type { GmailService } from "./gmail-service.js";
import { PropertyAutomationService } from "./property-automation-service.js";
import { PropertyIntegrationSettingsManager } from "./property-integration-settings.js";
import { PropertyPaymentService } from "./property-payment-service.js";
import { EmailDatabase } from "../storage/database.js";
import { PropertyPlatformStore } from "../storage/property-platform-store.js";
import { PropertyStore } from "../storage/property-store.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyAutomationService", () => {
  it("creates a scheduled charge once and drains durable reminder jobs", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-automation-"));
    temporaryDirs.push(directory);
    const database = new EmailDatabase(directory);
    const auth = new AuthService(database, 60);
    auth.initialize();
    const managerId = database.listUsers()[0]!.id;
    const tenantUser = auth.createInvitedUser({
      username: "automation.tenant",
      displayName: "Automation Tenant",
      password: "Automation!Tenant2026"
    });
    const properties = new PropertyStore(database.path);
    const platform = new PropertyPlatformStore(database.path);
    const property = properties.createProperty(managerId, propertyInput());
    const unit = platform.syncProperty(managerId, property.id);
    const tenant = properties.createTenant(managerId, {
      linkedUserId: tenantUser.id,
      firstName: "Automation",
      lastName: "Tenant",
      email: "automation@example.test",
      phone: "",
      status: "active"
    });
    const lease = properties.createLease(managerId, {
      propertyId: property.id,
      unitId: unit.id,
      tenantId: tenant.id,
      startDate: "2026-01-01",
      endDate: "2027-12-31",
      monthlyRentCents: 200_000,
      securityDepositCents: 0,
      dueDay: 1,
      status: "active"
    });
    const chargeDate = new Date().toISOString().slice(0, 10);
    platform.createRentSchedule(managerId, {
      propertyId: property.id,
      leaseId: lease.id,
      amountCents: 200_000,
      dueDay: Number(chargeDate.slice(8, 10)),
      descriptionTemplate: "{{month}} rent",
      nextChargeDate: chargeDate,
      reminderDays: [-1],
      enabled: true
    });
    const gmailConnectionId = "13b0f948-f75b-4fa5-9a62-0313028c98c4";
    const integrations = new PropertyIntegrationSettingsManager(directory, { gmailConnectionId });
    const sendMessage = vi.fn().mockResolvedValue({ id: "gmail-message-1", threadId: null, localCopyImported: true });
    const gmail = { sendMessage } as unknown as GmailService;
    const payments = new PropertyPaymentService(properties, () => integrations.current());
    const automation = new PropertyAutomationService(
      properties,
      platform,
      payments,
      gmail,
      integrations,
      5
    );

    const first = await automation.runNow();
    const second = await automation.runNow();

    expect(first).toMatchObject({
      chargesCreated: 1,
      notificationsCompleted: 2,
      notificationsFailed: 0,
      alreadyRunning: false
    });
    expect(second.chargesCreated).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const overview = platform.overview(managerId, integrations.view());
    expect(overview.ledgerEntries.filter((entry) => entry.entryType === "charge")).toHaveLength(1);
    expect(overview.notificationJobs).toEqual([
      expect.objectContaining({ channel: "in_app", status: "completed" }),
      expect.objectContaining({ channel: "email", status: "completed" })
    ]);

    await automation.close();
    platform.close();
    properties.close();
    database.close();
  });
});

function propertyInput() {
  return {
    name: "Automation House",
    addressLine1: "101 Test St",
    addressLine2: "",
    city: "Boca Raton",
    state: "FL",
    postalCode: "33486",
    propertyType: "single_family" as const,
    status: "setup" as const,
    bedrooms: 3,
    bathrooms: 2,
    monthlyRentCents: 200_000,
    notes: ""
  };
}
