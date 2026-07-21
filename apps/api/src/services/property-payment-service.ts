import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  PropertyPayment,
  PropertyPaymentCheckoutResult,
  PropertyPaymentConfiguration,
  PropertyPaymentMethod,
  PropertyRefundResult
} from "@email-client/shared";
import { PropertyStore, type PropertyPaymentGatewayUpdate } from "../storage/property-store.js";
import type { PropertyIntegrationRuntimeSettings } from "./property-integration-settings.js";

type JsonObject = Record<string, unknown>;

export class PropertyPaymentConfigurationError extends Error {}
export class PropertyPaymentProviderError extends Error {}

export class PropertyPaymentService {
  constructor(
    private readonly store: PropertyStore,
    private readonly settings: () => PropertyIntegrationRuntimeSettings,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  configuration(): PropertyPaymentConfiguration {
    const config = this.settings();
    return {
      stripe: {
        configured: Boolean(config.stripeSecretKey),
        methods: ["card", "apple_pay", "google_pay", "ach"]
      },
      paypal: {
        configured: Boolean(config.paypalClientId && config.paypalClientSecret),
        environment: config.paypalEnvironment,
        methods: ["paypal"]
      },
      zelle: {
        configured: Boolean(config.zelleRecipient),
        recipient: config.zelleRecipient,
        note: config.zelleNote
      },
      manual: {
        configured: true,
        methods: ["cash", "check", "other"]
      }
    };
  }

  async createCheckout(
    userId: string,
    paymentId: string,
    returnOrigin: string
  ): Promise<PropertyPaymentCheckoutResult> {
    const payment = this.store.getPayment(userId, paymentId);
    if (payment.status === "succeeded" || payment.status === "refunded") {
      throw new PropertyPaymentProviderError("This payment is already complete");
    }
    if (payment.provider === "stripe") return this.createStripeCheckout(userId, payment, returnOrigin);
    if (payment.provider === "paypal") return this.createPayPalOrder(userId, payment, returnOrigin);
    if (payment.provider === "zelle") return this.zelleInstructions(userId, payment);
    return this.manualInstructions(payment);
  }

  async sync(userId: string, paymentId: string): Promise<PropertyPayment> {
    const payment = this.store.getPayment(userId, paymentId);
    if (payment.provider === "stripe") return this.syncStripe(userId, payment);
    if (payment.provider === "paypal") return this.syncPayPal(userId, payment);
    return payment;
  }

  verifyStripeWebhook(rawBody: Buffer, signatureHeader: string | undefined): JsonObject {
    const secret = this.settings().stripeWebhookSecret;
    if (!secret) throw new PropertyPaymentConfigurationError("Stripe webhook secret is not configured");
    if (!signatureHeader) throw new PropertyPaymentProviderError("Stripe signature is missing");
    const parts = signatureHeader.split(",").map((part) => part.trim().split("=", 2));
    const timestamp = parts.find(([key]) => key === "t")?.[1];
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value).filter(Boolean) as string[];
    if (!timestamp || signatures.length === 0 || Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300) {
      throw new PropertyPaymentProviderError("Stripe signature is invalid or expired");
    }
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
    const valid = signatures.some((signature) => {
      if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
      const actual = Buffer.from(signature, "hex");
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    });
    if (!valid) throw new PropertyPaymentProviderError("Stripe signature verification failed");
    const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new PropertyPaymentProviderError("Stripe webhook payload is invalid");
    }
    return payload as JsonObject;
  }

  async verifyPayPalWebhook(headers: Record<string, string | undefined>, payload: JsonObject): Promise<void> {
    const webhookId = this.settings().paypalWebhookId;
    if (!webhookId) throw new PropertyPaymentConfigurationError("PayPal webhook ID is not configured");
    const token = await this.payPalToken();
    const response = await this.fetcher(`${this.payPalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: payload
      })
    });
    const data = await readProviderJson(response, "PayPal webhook verification failed");
    if (data.verification_status !== "SUCCESS") {
      throw new PropertyPaymentProviderError("PayPal webhook signature verification failed");
    }
  }

  applyProviderEvent(provider: "stripe" | "paypal", eventType: string, payload: JsonObject): PropertyPayment | null {
    const resource = provider === "stripe"
      ? objectValue(objectValue(payload.data)?.object)
      : objectValue(payload.resource);
    if (!resource) return null;
    const paymentId = provider === "stripe" ? stripePaymentId(resource) : payPalPaymentId(resource);
    const providerReference = provider === "stripe"
      ? stringOrObjectId(resource.payment_intent) ?? optionalString(resource.id)
      : payPalProviderReference(resource);
    let payment: PropertyPayment | null = null;
    try {
      payment = paymentId
        ? this.store.getPaymentWithOwner(paymentId).payment
        : providerReference
          ? this.store.findPaymentByProviderReference(provider, providerReference)
          : null;
    } catch {
      payment = null;
    }
    if (!payment) return null;
    const update = provider === "stripe"
      ? stripeEventUpdate(eventType, resource, payment)
      : payPalEventUpdate(eventType, resource, payment);
    if (!update) return payment;
    return this.store.updatePaymentGatewaySystem(payment.id, update, `${provider}_webhook_${eventType}`, payload);
  }

  async refund(
    userId: string,
    paymentId: string,
    amountCents: number | undefined,
    reason: string
  ): Promise<PropertyRefundResult> {
    const payment = this.store.getPayment(userId, paymentId);
    if (payment.status !== "succeeded") throw new PropertyPaymentProviderError("Only successful payments can be refunded");
    const amount = amountCents ?? payment.amountCents;
    if (amount <= 0 || amount > payment.amountCents) throw new PropertyPaymentProviderError("Refund amount exceeds the payment");
    let providerRefundId: string | null = null;
    if (payment.provider === "stripe") {
      const secretKey = this.settings().stripeSecretKey;
      if (!secretKey) throw new PropertyPaymentConfigurationError("Stripe is not configured");
      let paymentIntentId = payment.providerTransactionId;
      if (!paymentIntentId && payment.externalId) {
        const response = await this.fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(payment.externalId)}`, {
          headers: { Authorization: `Bearer ${secretKey}` }
        });
        const session = await readProviderJson(response, "Stripe payment could not be loaded");
        paymentIntentId = stringOrObjectId(session.payment_intent);
      }
      if (!paymentIntentId) throw new PropertyPaymentProviderError("Stripe payment transaction was not found");
      const response = await this.fetcher("https://api.stripe.com/v1/refunds", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `property-refund-${payment.id}-${amount}`
        },
        body: new URLSearchParams({ payment_intent: paymentIntentId, amount: String(amount), "metadata[property_payment_id]": payment.id })
      });
      const data = await readProviderJson(response, "Stripe refund failed");
      providerRefundId = requiredString(data.id, "Stripe did not return a refund ID");
    } else if (payment.provider === "paypal") {
      const token = await this.payPalToken();
      const orderId = payment.externalId;
      if (!orderId) throw new PropertyPaymentProviderError("PayPal order was not found");
      const order = await this.payPalOrder(token, orderId);
      const captureId = payPalCaptureId(order) ?? payment.providerTransactionId;
      if (!captureId) throw new PropertyPaymentProviderError("PayPal capture was not found");
      const response = await this.fetcher(`${this.payPalBaseUrl()}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `property-refund-${payment.id}-${amount}`
        },
        body: JSON.stringify({ amount: { value: (amount / 100).toFixed(2), currency_code: payment.currency } })
      });
      const data = await readProviderJson(response, "PayPal refund failed");
      providerRefundId = requiredString(data.id, "PayPal did not return a refund ID");
    } else {
      providerRefundId = `local-${randomUUID()}`;
    }
    const updated = this.store.updatePaymentGateway(userId, payment.id, {
      status: amount === payment.amountCents ? "refunded" : "succeeded",
      failureReason: null
    }, "refund_created", { amountCents: amount, providerRefundId, reason });
    return { payment: updated, amountCents: amount, providerRefundId };
  }

  private async createStripeCheckout(
    userId: string,
    payment: PropertyPayment,
    returnOrigin: string
  ): Promise<PropertyPaymentCheckoutResult> {
    const secretKey = this.settings().stripeSecretKey;
    if (!secretKey) throw new PropertyPaymentConfigurationError("Stripe is not configured");
    const body = new URLSearchParams({
      mode: "payment",
      success_url: `${returnOrigin}/properties?payment=${encodeURIComponent(payment.id)}&result=success`,
      cancel_url: `${returnOrigin}/properties?payment=${encodeURIComponent(payment.id)}&result=cancelled`,
      client_reference_id: payment.id,
      "metadata[property_payment_id]": payment.id,
      "payment_intent_data[metadata][property_payment_id]": payment.id,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": payment.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(payment.amountCents),
      "line_items[0][price_data][product_data][name]": `Rent payment - ${payment.propertyName}`
    });
    const response = await this.fetcher("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `property-payment-${payment.id}`
      },
      body
    });
    const data = await readProviderJson(response, "Stripe could not create a Checkout session");
    const externalId = requiredString(data.id, "Stripe did not return a Checkout session ID");
    const checkoutUrl = requiredString(data.url, "Stripe did not return a Checkout URL");
    const updated = this.store.updatePaymentGateway(userId, payment.id, {
      status: "processing",
      externalId,
      checkoutUrl,
      failureReason: null
    }, "stripe_checkout_created", data);
    return { payment: updated, action: "redirect", url: checkoutUrl, instructions: null };
  }

  private async syncStripe(userId: string, payment: PropertyPayment): Promise<PropertyPayment> {
    const secretKey = this.settings().stripeSecretKey;
    if (!secretKey) throw new PropertyPaymentConfigurationError("Stripe is not configured");
    if (!payment.externalId) throw new PropertyPaymentProviderError("This Stripe payment has no Checkout session");
    const query = new URLSearchParams({
      "expand[]": "payment_intent.latest_charge.payment_method_details"
    });
    const response = await this.fetcher(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(payment.externalId)}?${query}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const data = await readProviderJson(response, "Stripe payment status could not be loaded");
    const paymentStatus = optionalString(data.payment_status);
    const sessionStatus = optionalString(data.status);
    const status = paymentStatus === "paid"
      ? "succeeded"
      : sessionStatus === "expired"
        ? "cancelled"
        : "processing";
    return this.store.updatePaymentGateway(userId, payment.id, {
      status,
      method: stripeMethod(data) ?? payment.method,
      providerTransactionId: stringOrObjectId(data.payment_intent) ?? payment.providerTransactionId,
      paidAt: status === "succeeded" ? new Date().toISOString() : payment.paidAt,
      failureReason: null
    }, "stripe_status_synced", data);
  }

  private async createPayPalOrder(
    userId: string,
    payment: PropertyPayment,
    returnOrigin: string
  ): Promise<PropertyPaymentCheckoutResult> {
    const token = await this.payPalToken();
    const response = await this.fetcher(`${this.payPalBaseUrl()}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `property-payment-${payment.id}`
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: payment.id,
          custom_id: payment.id,
          description: `Rent payment - ${payment.propertyName}`,
          amount: {
            currency_code: payment.currency.toUpperCase(),
            value: (payment.amountCents / 100).toFixed(2)
          }
        }],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: "PAY_NOW",
              return_url: `${returnOrigin}/properties?payment=${encodeURIComponent(payment.id)}&result=success`,
              cancel_url: `${returnOrigin}/properties?payment=${encodeURIComponent(payment.id)}&result=cancelled`
            }
          }
        }
      })
    });
    const data = await readProviderJson(response, "PayPal could not create an order");
    const externalId = requiredString(data.id, "PayPal did not return an order ID");
    const links = Array.isArray(data.links) ? data.links as JsonObject[] : [];
    const checkoutUrl = links.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
    if (typeof checkoutUrl !== "string") {
      throw new PropertyPaymentProviderError("PayPal did not return an approval link");
    }
    const updated = this.store.updatePaymentGateway(userId, payment.id, {
      status: "processing",
      externalId,
      checkoutUrl,
      failureReason: null
    }, "paypal_order_created", data);
    return { payment: updated, action: "redirect", url: checkoutUrl, instructions: null };
  }

  private async syncPayPal(userId: string, payment: PropertyPayment): Promise<PropertyPayment> {
    if (!payment.externalId) throw new PropertyPaymentProviderError("This PayPal payment has no order");
    const token = await this.payPalToken();
    let data = await this.payPalOrder(token, payment.externalId);
    if (optionalString(data.status) === "APPROVED") {
      const response = await this.fetcher(
        `${this.payPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(payment.externalId)}/capture`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "PayPal-Request-Id": `capture-${payment.id}`
          },
          body: "{}"
        }
      );
      data = await readProviderJson(response, "PayPal could not capture the approved order");
    }
    const providerStatus = optionalString(data.status);
    const status = providerStatus === "COMPLETED"
      ? "succeeded"
      : providerStatus === "VOIDED"
        ? "cancelled"
        : "processing";
    return this.store.updatePaymentGateway(userId, payment.id, {
      status,
      method: "paypal",
      providerTransactionId: payPalCaptureId(data) ?? payment.providerTransactionId,
      paidAt: status === "succeeded" ? new Date().toISOString() : payment.paidAt,
      failureReason: null
    }, "paypal_status_synced", data);
  }

  private zelleInstructions(userId: string, payment: PropertyPayment): PropertyPaymentCheckoutResult {
    const config = this.settings();
    const recipient = config.zelleRecipient;
    if (!recipient) throw new PropertyPaymentConfigurationError("Zelle recipient is not configured");
    const reference = payment.reference ?? `RENT-${payment.id.slice(0, 8).toUpperCase()}`;
    const updated = this.store.updatePaymentGateway(userId, payment.id, {
      status: "pending",
      reference
    }, "zelle_instructions_created", { recipient, reference });
    return {
      payment: updated,
      action: "instructions",
      url: null,
      instructions: `Send ${formatMoney(payment.amountCents, payment.currency)} to ${recipient}. Use ${reference} in the memo. ${config.zelleNote}`
    };
  }

  private manualInstructions(payment: PropertyPayment): PropertyPaymentCheckoutResult {
    return {
      payment,
      action: "instructions",
      url: null,
      instructions: "Record the receipt or check reference, then mark this payment successful after the funds are verified."
    };
  }

  private async payPalToken(): Promise<string> {
    const config = this.settings();
    const clientId = config.paypalClientId;
    const secret = config.paypalClientSecret;
    if (!clientId || !secret) throw new PropertyPaymentConfigurationError("PayPal is not configured");
    const response = await this.fetcher(`${this.payPalBaseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    });
    const data = await readProviderJson(response, "PayPal authorization failed");
    return requiredString(data.access_token, "PayPal did not return an access token");
  }

  private async payPalOrder(token: string, orderId: string): Promise<JsonObject> {
    const response = await this.fetcher(
      `${this.payPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return readProviderJson(response, "PayPal order status could not be loaded");
  }

  private payPalBaseUrl(): string {
    return this.settings().paypalEnvironment === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  }
}

async function readProviderJson(response: Response, fallback: string): Promise<JsonObject> {
  const data = await response.json().catch(() => ({})) as JsonObject;
  if (response.ok) return data;
  const message = providerErrorMessage(data) ?? `${fallback} (${response.status})`;
  throw new PropertyPaymentProviderError(message);
}

function providerErrorMessage(data: JsonObject): string | null {
  const error = data.error;
  if (error && typeof error === "object") {
    const message = (error as JsonObject).message;
    if (typeof message === "string") return message;
  }
  if (typeof data.message === "string") return data.message;
  if (typeof data.error_description === "string") return data.error_description;
  return null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new PropertyPaymentProviderError(message);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stripeMethod(session: JsonObject): PropertyPaymentMethod | null {
  const paymentIntent = objectValue(session.payment_intent);
  const charge = objectValue(paymentIntent?.latest_charge);
  const details = objectValue(charge?.payment_method_details);
  const type = optionalString(details?.type);
  if (type === "us_bank_account") return "ach";
  if (type !== "card") return null;
  const card = objectValue(details?.card);
  const wallet = objectValue(card?.wallet);
  const walletType = optionalString(wallet?.type);
  if (walletType === "apple_pay") return "apple_pay";
  if (walletType === "google_pay") return "google_pay";
  return "card";
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringOrObjectId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return optionalString(objectValue(value)?.id);
}

function stripePaymentId(resource: JsonObject): string | null {
  const metadata = objectValue(resource.metadata);
  return optionalString(metadata?.property_payment_id) ?? optionalString(resource.client_reference_id);
}

function stripeEventUpdate(
  eventType: string,
  resource: JsonObject,
  payment: PropertyPayment
): PropertyPaymentGatewayUpdate | null {
  const transactionId = stringOrObjectId(resource.payment_intent) ?? payment.providerTransactionId;
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(eventType)) {
    const succeeded = resource.payment_status === "paid" || eventType.endsWith("succeeded");
    return {
      status: succeeded ? "succeeded" : "processing",
      providerTransactionId: transactionId,
      paidAt: succeeded ? new Date().toISOString() : payment.paidAt,
      failureReason: null
    };
  }
  if (["checkout.session.async_payment_failed", "payment_intent.payment_failed"].includes(eventType)) {
    return {
      status: "failed",
      providerTransactionId: transactionId,
      failureReason: optionalString(objectValue(resource.last_payment_error)?.message) ?? "Payment provider reported a failure"
    };
  }
  if (eventType === "charge.refunded") {
    const amountRefunded = Number(resource.amount_refunded ?? 0);
    return {
      status: amountRefunded >= payment.amountCents ? "refunded" : "succeeded",
      providerTransactionId: transactionId,
      failureReason: null
    };
  }
  return null;
}

function payPalPaymentId(resource: JsonObject): string | null {
  const direct = optionalString(resource.custom_id) ?? optionalString(resource.invoice_id);
  if (direct) return direct;
  const units = Array.isArray(resource.purchase_units) ? resource.purchase_units as JsonObject[] : [];
  return optionalString(units[0]?.custom_id) ?? optionalString(units[0]?.reference_id);
}

function payPalProviderReference(resource: JsonObject): string | null {
  const related = objectValue(objectValue(resource.supplementary_data)?.related_ids);
  return optionalString(related?.order_id)
    ?? optionalString(related?.capture_id)
    ?? optionalString(resource.id);
}

function payPalEventUpdate(
  eventType: string,
  resource: JsonObject,
  payment: PropertyPayment
): PropertyPaymentGatewayUpdate | null {
  const transactionId = eventType.startsWith("PAYMENT.CAPTURE.")
    ? optionalString(resource.id) ?? payment.providerTransactionId
    : payment.providerTransactionId;
  if (["PAYMENT.CAPTURE.COMPLETED", "CHECKOUT.ORDER.COMPLETED"].includes(eventType)) {
    return { status: "succeeded", providerTransactionId: transactionId, paidAt: new Date().toISOString(), failureReason: null };
  }
  if (eventType === "CHECKOUT.ORDER.APPROVED") {
    return { status: "processing", providerTransactionId: transactionId, failureReason: null };
  }
  if (["PAYMENT.CAPTURE.DENIED", "CHECKOUT.PAYMENT-APPROVAL.REVERSED"].includes(eventType)) {
    return { status: "failed", providerTransactionId: transactionId, failureReason: `PayPal reported ${eventType}` };
  }
  if (["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(eventType)) {
    return { status: "refunded", providerTransactionId: transactionId, failureReason: null };
  }
  return null;
}

function payPalCaptureId(order: JsonObject): string | null {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units as JsonObject[] : [];
  const payments = objectValue(units[0]?.payments);
  const captures = Array.isArray(payments?.captures) ? payments.captures as JsonObject[] : [];
  return optionalString(captures[0]?.id);
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase()
  }).format(amountCents / 100);
}
