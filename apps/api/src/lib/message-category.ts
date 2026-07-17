import type { InboxCategory } from "@email-client/shared";

interface MessageCategoryInput {
  senderAddress: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string>;
}

const SOCIAL_DOMAINS = [
  "facebookmail.com",
  "instagram.com",
  "linkedin.com",
  "meetup.com",
  "nextdoor.com",
  "pinterest.com",
  "redditmail.com",
  "tiktok.com",
  "twitter.com"
];

const PROMOTION_TERMS = /\b(coupon|deal|discount|exclusive offer|flash sale|free shipping|limited time|newsletter|promo(?:tion)?|save \d+%|sale|special offer|unsubscribe)\b/i;
const SOCIAL_TERMS = /\b(commented|connection request|friend request|invited you|liked your|mentioned you|new connection|new follower|new post|shared a post|tagged you)\b/i;
const UPDATE_TERMS = /\b(account alert|appointment|confirmation|delivery|digest|invoice|order|password|payment|receipt|reservation|security|shipment|shipping|statement|status update|tracking|verification|verify)\b/i;

export function gmailInboxCategory(labelIds: readonly string[]): InboxCategory {
  if (labelIds.includes("CATEGORY_PROMOTIONS")) return "promotions";
  if (labelIds.includes("CATEGORY_SOCIAL")) return "social";
  if (labelIds.includes("CATEGORY_UPDATES") || labelIds.includes("CATEGORY_FORUMS")) return "updates";
  return "primary";
}

export function classifyInboxCategory(input: MessageCategoryInput): InboxCategory {
  const headers = new Map(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const gmailLabels = headers.get("x-archive-mail-gmail-label-ids")
    ?.split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (gmailLabels?.length) return gmailInboxCategory(gmailLabels);

  const sender = input.senderAddress.trim().toLowerCase();
  const subject = input.subject.trim();
  const bodySample = input.bodyText.slice(0, 2_000);
  const senderDomain = sender.split("@").at(-1) ?? "";
  const senderName = sender.split("@")[0] ?? "";
  const precedence = headers.get("precedence")?.toLowerCase() ?? "";

  if (SOCIAL_DOMAINS.some((domain) => senderDomain === domain || senderDomain.endsWith(`.${domain}`))
    || SOCIAL_TERMS.test(subject)) {
    return "social";
  }
  if (headers.has("list-unsubscribe")
    || headers.has("list-id")
    || precedence === "bulk"
    || precedence === "list"
    || /(?:deal|marketing|newsletter|offer|promo|sales)/i.test(senderName)
    || PROMOTION_TERMS.test(`${subject} ${bodySample}`)) {
    return "promotions";
  }
  if (headers.has("auto-submitted")
    || /(?:alert|automated|notification|notify|no-?reply)/i.test(senderName)
    || UPDATE_TERMS.test(subject)) {
    return "updates";
  }
  return "primary";
}
