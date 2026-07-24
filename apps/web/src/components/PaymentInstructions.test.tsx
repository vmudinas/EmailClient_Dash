import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropertyPaymentConfiguration, PropertyPaymentProvider } from "@email-client/shared";
import { PaymentInstructionList } from "./PropertyManagementView.js";

afterEach(cleanup);

const configuration: PropertyPaymentConfiguration = {
  stripe: { configured: true, methods: ["card", "apple_pay", "google_pay", "ach"] },
  paypal: { configured: false, environment: "sandbox", methods: ["paypal"] },
  zelle: { configured: true, recipient: "landlord@example.test", note: "Include the unit number." },
  appleCash: { configured: true, recipient: "+15551234567", note: "" },
  manual: { configured: true, methods: ["cash", "check", "other"] }
};

function payment(overrides: Partial<Parameters<typeof PaymentInstructionList>[0]["payments"][number]> = {}) {
  return {
    id: "pay-1",
    propertyId: "prop-1",
    propertyName: "1299 SW 12th Ave",
    leaseId: null,
    chargeId: null,
    provider: "apple_cash" as PropertyPaymentProvider,
    method: "apple_cash",
    amountCents: 185_000,
    currency: "USD",
    status: "pending",
    externalId: null,
    providerTransactionId: null,
    checkoutUrl: null,
    reference: "RENT-A1B2C3D4",
    paidAt: null,
    failureReason: null,
    notes: "",
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    ...overrides
  } as Parameters<typeof PaymentInstructionList>[0]["payments"][number];
}

function renderList(payments = [payment()]) {
  const onCopied = vi.fn();
  render(<PaymentInstructionList payments={payments} configuration={configuration} onCopied={onCopied} />);
  return { onCopied };
}

describe("PaymentInstructionList", () => {
  it("shows the Apple Cash recipient and reference so a renter can pay without re-opening checkout", () => {
    renderList();
    expect(screen.getByText("+15551234567")).toBeTruthy();
    expect(screen.getByText("RENT-A1B2C3D4")).toBeTruthy();
    expect(screen.getByText(/\$1,850\.00/)).toBeTruthy();
  });

  it("explains that Apple Cash is sent from Messages", () => {
    renderList();
    expect(screen.getByText(/Open Messages/)).toBeTruthy();
  });

  it("states that confirmation is manual, not automatic", () => {
    renderList();
    expect(screen.getByText(/cannot confirm it automatically/)).toBeTruthy();
  });

  it("shows the Zelle recipient and its note for a Zelle payment", () => {
    renderList([payment({ provider: "zelle", method: "zelle" })]);
    expect(screen.getByText("landlord@example.test")).toBeTruthy();
    expect(screen.getByText(/choose Zelle/)).toBeTruthy();
    expect(screen.getByText("Include the unit number.")).toBeTruthy();
  });

  it("copies the recipient to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { onCopied } = renderList();
    fireEvent.click(screen.getByLabelText("Copy Apple Cash recipient"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("+15551234567"));
    expect(onCopied).toHaveBeenCalledWith("Recipient");
  });

  it("copies the reference to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderList();
    fireEvent.click(screen.getByLabelText("Copy payment reference"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("RENT-A1B2C3D4"));
  });

  it("does not break when the clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const { onCopied } = renderList();
    fireEvent.click(screen.getByLabelText("Copy Apple Cash recipient"));
    await waitFor(() => expect(onCopied).not.toHaveBeenCalled());
    expect(screen.getByText("+15551234567")).toBeTruthy();
  });

  it("tells the renter to ask the manager when no recipient is configured", () => {
    render(
      <PaymentInstructionList
        payments={[payment()]}
        configuration={{ ...configuration, appleCash: { configured: false, recipient: null, note: "" } }}
        onCopied={vi.fn()}
      />
    );
    expect(screen.getByText(/Ask your property manager where to send/)).toBeTruthy();
  });

  it("renders one card per outstanding payment", () => {
    renderList([payment(), payment({ id: "pay-2", provider: "zelle", method: "zelle", reference: "RENT-ZZZZ1111" })]);
    expect(screen.getByText("RENT-A1B2C3D4")).toBeTruthy();
    expect(screen.getByText("RENT-ZZZZ1111")).toBeTruthy();
  });
});
