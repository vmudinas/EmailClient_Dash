import { describe, expect, it } from "vitest";
import type { MessageSummary } from "@email-client/shared";
import { upcomingShipments } from "./ShipmentHighlights.js";

const MESSAGE: MessageSummary = {
  id: "shipment-old",
  archiveId: "archive-1",
  folderId: "inbox",
  folderPath: "Inbox",
  subject: "Shipment update",
  sender: { name: "UPS", address: "tracking@ups.com" },
  recipients: [],
  sentAt: null,
  receivedAt: "2026-07-20T12:00:00.000Z",
  preview: "Shipment update",
  hasAttachments: false,
  attachmentCount: 0,
  inboxCategory: "mail_tracking",
  shipment: {
    carrier: "ups",
    merchant: "Amazon",
    trackingNumber: "1Z999AA10123456784",
    orderNumber: null,
    status: "in_transit",
    estimatedDeliveryDate: "2026-07-23",
    trackingUrl: "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784"
  },
  state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
};

describe("upcoming shipments", () => {
  it("uses the newest update for a tracking number and removes delivered packages", () => {
    const delivered: MessageSummary = {
      ...MESSAGE,
      id: "shipment-new",
      receivedAt: "2026-07-22T12:00:00.000Z",
      shipment: { ...MESSAGE.shipment!, status: "delivered" }
    };
    expect(upcomingShipments([MESSAGE, delivered], new Date("2026-07-22T14:00:00.000Z"))).toEqual([]);
  });
});
