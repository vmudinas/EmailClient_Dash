import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PropertyStore } from "../storage/property-store.js";
import { PropertyPaymentService } from "./property-payment-service.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyPaymentService", () => {
  it("creates Stripe Checkout and synchronizes a confirmed Apple Pay payment", async () => {
    const { store, ownerId, paymentId } = createPayment("stripe", "card");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "cs_test_123", url: "https://checkout.stripe.test/session" }))
      .mockResolvedValueOnce(jsonResponse({
        id: "cs_test_123",
        status: "complete",
        payment_status: "paid",
        payment_intent: {
          latest_charge: {
            payment_method_details: { type: "card", card: { wallet: { type: "apple_pay" } } }
          }
        }
      }));
    const service = new PropertyPaymentService(store, () => ({
      stripeSecretKey: "sk_test_secret",
      stripeWebhookSecret: null,
      paypalClientId: null,
      paypalClientSecret: null,
      paypalEnvironment: "sandbox",
      paypalWebhookId: null,
      zelleRecipient: null,
      zelleNote: "",
      twilioAccountSid: null,
      twilioAuthToken: null,
      twilioFromNumber: null,
      twilioMessagingServiceSid: null,
      gmailConnectionId: null
    }), fetcher);

    const checkout = await service.createCheckout(ownerId, paymentId, "https://rent.example.test");
    const synchronized = await service.sync(ownerId, paymentId);

    expect(checkout).toMatchObject({ action: "redirect", url: "https://checkout.stripe.test/session" });
    expect(synchronized).toMatchObject({ status: "succeeded", method: "apple_pay", externalId: "cs_test_123" });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=125000");
    store.close();
  });

  it("creates traceable Zelle instructions without claiming the payment succeeded", async () => {
    const { store, ownerId, paymentId } = createPayment("zelle", "zelle");
    const service = new PropertyPaymentService(store, () => ({
      stripeSecretKey: null,
      stripeWebhookSecret: null,
      paypalClientId: null,
      paypalClientSecret: null,
      paypalEnvironment: "sandbox",
      paypalWebhookId: null,
      zelleRecipient: "rent@example.test",
      zelleNote: "Use the property address in the memo.",
      twilioAccountSid: null,
      twilioAuthToken: null,
      twilioFromNumber: null,
      twilioMessagingServiceSid: null,
      gmailConnectionId: null
    }));

    const checkout = await service.createCheckout(ownerId, paymentId, "https://rent.example.test");

    expect(checkout.action).toBe("instructions");
    expect(checkout.instructions).toContain("rent@example.test");
    expect(checkout.payment.status).toBe("pending");
    expect(checkout.payment.reference).toMatch(/^RENT-/);
    store.close();
  });

  it("rejects forged Stripe webhook signatures and accepts the configured secret", () => {
    const { store } = createPayment("stripe", "card");
    const service = new PropertyPaymentService(store, () => ({
      stripeSecretKey: "sk_test_secret",
      stripeWebhookSecret: "whsec_test_secret",
      paypalClientId: null,
      paypalClientSecret: null,
      paypalEnvironment: "sandbox",
      paypalWebhookId: null,
      zelleRecipient: null,
      zelleNote: "",
      twilioAccountSid: null,
      twilioAuthToken: null,
      twilioFromNumber: null,
      twilioMessagingServiceSid: null,
      gmailConnectionId: null
    }));
    const rawBody = Buffer.from(JSON.stringify({ id: "evt_test", type: "checkout.session.completed" }));
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = createHmac("sha256", "whsec_test_secret")
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex");

    expect(service.verifyStripeWebhook(rawBody, `t=${timestamp},v1=${signature}`))
      .toMatchObject({ id: "evt_test" });
    expect(() => service.verifyStripeWebhook(rawBody, `t=${timestamp},v1=${"0".repeat(64)}`))
      .toThrow("Stripe signature verification failed");
    store.close();
  });

  it("creates a Stripe refund against the stored provider transaction", async () => {
    const { store, ownerId, paymentId } = createPayment("stripe", "card");
    store.updatePaymentGateway(ownerId, paymentId, {
      status: "succeeded",
      providerTransactionId: "pi_test_123",
      paidAt: "2026-07-20T12:00:00.000Z"
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "re_test_123" }));
    const service = new PropertyPaymentService(store, () => ({
      stripeSecretKey: "sk_test_secret",
      stripeWebhookSecret: null,
      paypalClientId: null,
      paypalClientSecret: null,
      paypalEnvironment: "sandbox",
      paypalWebhookId: null,
      zelleRecipient: null,
      zelleNote: "",
      twilioAccountSid: null,
      twilioAuthToken: null,
      twilioFromNumber: null,
      twilioMessagingServiceSid: null,
      gmailConnectionId: null
    }), fetcher);

    const refund = await service.refund(ownerId, paymentId, 25_000, "Tenant overpaid");

    expect(refund).toMatchObject({ amountCents: 25_000, providerRefundId: "re_test_123" });
    expect(refund.payment.status).toBe("succeeded");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("payment_intent=pi_test_123");
    store.close();
  });
});

function createPayment(provider: "stripe" | "zelle", method: "card" | "zelle") {
  const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-payment-"));
  temporaryDirs.push(directory);
  const store = new PropertyStore(resolve(directory, "test.sqlite"));
  const ownerId = randomUUID();
  const property = store.createProperty(ownerId, {
    name: "Test House",
    addressLine1: "101 Test St",
    addressLine2: "",
    city: "Boca Raton",
    state: "FL",
    postalCode: "33486",
    propertyType: "single_family",
    status: "setup",
    bedrooms: null,
    bathrooms: null,
    monthlyRentCents: null,
    notes: ""
  });
  const payment = store.createPayment(ownerId, {
    propertyId: property.id,
    leaseId: null,
    chargeId: null,
    provider,
    method,
    amountCents: 125_000,
    currency: "USD",
    status: "pending",
    reference: null,
    paidAt: null,
    notes: ""
  });
  return { store, ownerId, paymentId: payment.id };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
