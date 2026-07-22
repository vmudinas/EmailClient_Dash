import { ExternalLink, PackageCheck, Truck } from "lucide-react";
import type { MessageSummary, ShipmentCarrier, ShipmentStatus } from "@email-client/shared";

interface ShipmentHighlightsProps {
  messages: MessageSummary[];
  onSelect(message: MessageSummary): void;
}

export function ShipmentHighlights({ messages, onSelect }: ShipmentHighlightsProps) {
  const shipments = upcomingShipments(messages);
  if (shipments.length === 0) return null;

  const openShipment = (message: MessageSummary) => {
    const url = message.shipment?.trackingUrl;
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    onSelect(message);
  };

  return (
    <section className="shipment-highlights" aria-label="Arriving soon">
      <header><Truck size={15} /><strong>Arriving soon</strong></header>
      <div className="shipment-highlight-list">
        {shipments.map((message) => {
          const shipment = message.shipment!;
          return (
            <article className="shipment-highlight" key={shipmentKey(message)}>
              <span className={`shipment-carrier-icon ${shipment.carrier}`} aria-hidden="true"><PackageCheck size={17} /></span>
              <div className="shipment-highlight-copy">
                <strong>Order from {shipment.merchant}</strong>
                <small>{shipment.trackingNumber ? `${carrierLabel(shipment.carrier)} · ${maskedTrackingNumber(shipment.trackingNumber)}` : carrierLabel(shipment.carrier)}</small>
              </div>
              <span className={`shipment-eta ${shipment.status}`}>{shipmentStatusLabel(shipment.status, shipment.estimatedDeliveryDate)}</span>
              <button type="button" onClick={() => openShipment(message)}>
                {shipment.trackingUrl ? <ExternalLink size={14} /> : null}
                View order
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function upcomingShipments(messages: MessageSummary[], now = new Date()): MessageSummary[] {
  const distinct = new Map<string, MessageSummary>();
  for (const message of messages) {
    if (!message.shipment) continue;
    const key = shipmentKey(message);
    const existing = distinct.get(key);
    if (!existing || messageTime(message) > messageTime(existing)) distinct.set(key, message);
  }
  return [...distinct.values()]
    .filter((message) => isUpcoming(message, now))
    .sort((left, right) => {
      const leftEta = dateValue(left.shipment?.estimatedDeliveryDate) ?? Number.MAX_SAFE_INTEGER;
      const rightEta = dateValue(right.shipment?.estimatedDeliveryDate) ?? Number.MAX_SAFE_INTEGER;
      return leftEta - rightEta || messageTime(right) - messageTime(left);
    })
    .slice(0, 6);
}

function isUpcoming(message: MessageSummary, now: Date): boolean {
  const shipment = message.shipment!;
  if (shipment.status === "delivered") return false;
  const eta = shipment.estimatedDeliveryDate ? localDate(shipment.estimatedDeliveryDate) : null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (eta) return eta.getTime() >= startOfToday.getTime() - 86_400_000;
  const age = now.getTime() - messageTime(message);
  return age <= 45 * 86_400_000 && ["order_confirmed", "shipped", "in_transit", "out_for_delivery", "delayed"].includes(shipment.status);
}

function shipmentStatusLabel(status: ShipmentStatus, estimatedDeliveryDate: string | null): string {
  if (status === "out_for_delivery" && !estimatedDeliveryDate) return "Out for delivery";
  if (status === "delayed" && !estimatedDeliveryDate) return "Delayed";
  if (!estimatedDeliveryDate) {
    if (status === "in_transit") return "In transit";
    if (status === "shipped") return "Shipped";
    if (status === "order_confirmed") return "Order confirmed";
    return "Tracking available";
  }
  const date = localDate(estimatedDeliveryDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const difference = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  const expected = difference === 0
    ? "Expected today"
    : difference === 1
      ? "Expected tomorrow"
      : `Expected by ${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
  return status === "delayed" ? `Delayed · ${expected}` : expected;
}

function shipmentKey(message: MessageSummary): string {
  const shipment = message.shipment!;
  return shipment.trackingNumber
    ? `tracking:${shipment.trackingNumber}`
    : shipment.orderNumber
      ? `order:${shipment.merchant.toLowerCase()}:${shipment.orderNumber}`
      : `message:${shipment.merchant.toLowerCase()}:${shipment.estimatedDeliveryDate ?? message.id}`;
}

function carrierLabel(carrier: ShipmentCarrier): string {
  if (carrier === "amazon") return "Amazon Logistics";
  if (carrier === "ups") return "UPS";
  if (carrier === "fedex") return "FedEx";
  if (carrier === "usps") return "USPS";
  if (carrier === "dhl") return "DHL";
  return "Shipping update";
}

function maskedTrackingNumber(value: string): string {
  return value.length <= 7 ? value : `•••• ${value.slice(-6)}`;
}

function messageTime(message: MessageSummary): number {
  return Date.parse(message.receivedAt ?? message.sentAt ?? "") || 0;
}

function dateValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = localDate(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12);
}
