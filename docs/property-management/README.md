# Property Management

Archive Mail includes a property-management workspace for a private landlord or small property manager. It shares the existing React/Fastify application shell while keeping property resources separate from every user's private mail, calendar, drafts, AI configuration, and Gmail connections.

## Implemented Features

### Portfolio and access

- A manager dashboard with properties, units, tenants, leases, service requests, balances, and payment history.
- Five seeded properties using a repository-safe generic property illustration. Personal photos override it locally from ignored storage.
- Organizations and organization memberships, with a default organization created for the primary administrator.
- Single-family and multi-unit records. New single-family properties receive a default `Main unit`; leases can be assigned to a specific unit.
- Time-limited tenant invitations that create a property-only user with a strong password.
- Browser sessions use `HttpOnly`, `SameSite=Strict` cookies. Desktop sessions continue to use the local desktop bridge token.
- Server-side tenant isolation for units, leases, documents, ledger entries, receipts, requests, comments, notifications, and communication consent.
- Inaccessible property resources return not-found responses rather than disclosing that another user's resource exists.

### Documents and service requests

- Authenticated document upload, preview, download, versioning, visibility, SHA-256 integrity metadata, and optional tenant acknowledgement.
- Files are limited to 25 MB and checked by MIME type and file signature before storage.
- Service-request comments, attachments, assignment metadata, and immutable status history.
- Tenant-visible and manager-only request comments.
- Request attachment preview/download through authorized endpoints.

### Rent, payments, and reporting

- Dated rent charges, recurring monthly rent schedules, immutable ledger entries, adjustments, allocations, receipts, refunds, and CSV export.
- Stripe-hosted Checkout for eligible cards, Apple Pay, Google Pay, and ACH methods enabled in the Stripe account.
- PayPal Orders and captures.
- Zelle instructions and manager reconciliation, plus manual cash/check/other records.
- Provider transaction IDs and payment status history without storing card or bank credentials.
- Signature-verified Stripe and PayPal webhooks stored in a durable, idempotent event queue.
- Successful provider events create payment ledger entries and receipts exactly once.
- Manager-triggered full or partial refunds for supported providers.

### Notifications and operations

- Durable SQLite notification jobs with idempotency keys, attempt counts, retry timing, provider IDs, and delivery history.
- In-app reminders, Gmail-delivered email reminders, and optional Twilio Messaging Service SMS.
- Explicit SMS opt-in records and signed Twilio STOP webhook handling. Opted-out numbers are suppressed.
- A non-overlapping automation worker that creates due rent charges, processes provider events, and sends queued reminders.
- A **Run now** control and visible job/delivery state in the Communications tab.
- Online SQLite backups containing the database, property files, images, and relevant settings, with retention and an Admin backup history panel.
- NAS-friendly SQLite WAL mode with a 30-second busy timeout on property connections.

## Application Areas

The web application exposes these role-aware areas:

- `/properties` — manager portfolio or tenant portal, selected from the shared application navigation.
- `/portal` — tenant-friendly entry point after accepting an invitation.
- `/portal/invite?token=...` — public invitation acceptance screen.
- **Overview** — portfolio or tenant summary.
- **Properties** — properties, photos, and units.
- **Tenants & leases** — tenant records, invitation links, and lease details.
- **Requests** — service request workflow, comments, attachments, and history.
- **Payments** — charges, payment attempts, hosted checkout, sync, receipts, and refunds.
- **Documents** — agreements and other shared property files.
- **Accounting** — schedules, ledger, adjustments, and CSV export.
- **Communications** — provider configuration status, consent, notification jobs, automation, and backups.

Mail data is never exposed through the tenant portal. A tenant user receives only the `properties` screen permission at invitation acceptance.

## Initial Setup

1. Sign in as an administrator and immediately replace the bootstrap PIN.
2. Open **Properties** and verify the seeded portfolio or create properties and units.
3. Create tenants and leases, assigning each lease to the correct unit.
4. Use **Invite** next to a tenant and send the copied 48-hour link through a trusted channel.
5. Upload the rental agreement, select tenant visibility, and optionally require acknowledgement.
6. Create a recurring rent schedule and choose reminder offsets such as `-7,-3,0,3`.
7. Open **Communications > Configure** to save payment and notification provider settings, or provide them through the environment.
8. Run automation once, inspect the notification queue, and create a backup before enabling public tenant access.

## Provider Configuration

Admin-saved property integration secrets are stored in `/data/property-integrations.json` with mode `0600` and take precedence over environment fallbacks. Secrets are never returned to the browser. On Synology, also restrict the `/data` shared-folder ACL to the service administrator and container account.

```dotenv
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_ENVIRONMENT=live
PAYPAL_WEBHOOK_ID=...

ZELLE_RECIPIENT=rent@example.com
ZELLE_PAYMENT_NOTE=Include the property address and payment reference in the memo.

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_SERVICE_SID=MG...
PROPERTY_GMAIL_CONNECTION_ID=<gmail-connection-uuid>

PROPERTY_AUTOMATION_INTERVAL_MINUTES=5
PROPERTY_BACKUP_RETENTION=7
```

Leaving provider environment variables unset keeps the fields editable in the Admin UI. A Gmail connection ID must reference a connected account with send permission.

## Webhook Endpoints

Tenant access and provider webhooks require a stable HTTPS origin in `EMAIL_CLIENT_PUBLIC_URL`.

| Provider | Public endpoint |
| --- | --- |
| Stripe | `https://mail.example.com/api/property-webhooks/stripe` |
| PayPal | `https://mail.example.com/api/property-webhooks/paypal` |
| Twilio incoming messages | `https://mail.example.com/api/property-webhooks/twilio/inbound` |

Configure the Stripe signing secret and PayPal webhook ID returned by those providers. Configure Twilio's Messaging Service incoming-message webhook with the exact public URL. The reverse proxy must preserve the public host and protocol; set `EMAIL_CLIENT_TRUST_PROXY=true` only when clients cannot bypass that proxy.

The Stripe handler verifies the timestamped HMAC signature before JSON parsing. The PayPal handler calls PayPal's verification endpoint. The Twilio handler validates `X-Twilio-Signature` before processing STOP-like commands.

References: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [Stripe webhooks](https://docs.stripe.com/webhooks?lang=node), [PayPal webhooks](https://developer.paypal.com/api/rest/webhooks/), [PayPal event names](https://developer.paypal.com/api/rest/webhooks/event-names/), [Twilio messaging policy](https://www.twilio.com/en-us/legal/messaging-policy), and [Twilio consent API](https://www.twilio.com/docs/messaging/features/consent-api).

## Durable Automation

The API process runs one non-overlapping property automation loop. Durable work is claimed from SQLite, so a restart does not lose queued reminders or provider events.

The loop:

1. Claims each due rent schedule by schedule ID and charge date.
2. Creates the charge and immutable ledger entry exactly once.
3. Enqueues reminder jobs with deterministic idempotency keys.
4. Claims and applies verified provider events.
5. Claims up to 100 due notification jobs per run.
6. Records success, suppression, retry, or terminal failure in delivery history.

Failed notification jobs use bounded exponential retry timing and stop after five attempts. SMS is checked against current consent immediately before delivery.

## Financial Rules

- The browser return URL never marks a payment successful.
- Stripe or PayPal status synchronization and verified provider events are authoritative.
- Ledger history is append-only; corrections use adjustments or refunds.
- A positive ledger amount increases the tenant balance. Payments are stored as negative ledger entries.
- Receipt numbers and provider event IDs are idempotent.
- Hosted providers collect card and bank credentials; this application stores only amounts, states, references, and provider IDs.
- Zelle and manual payments require manager confirmation because no general-purpose Zelle merchant-status API is used.

## Documents and Backups

Property documents and request attachments are stored under `/data/property-files`; seeded and uploaded property photos are under `/data/property-images`. For local development, private seed photos can be placed in the ignored repository folder `data/property-images` using the filenames referenced by the seed records. Missing private photos use `apps/api/property-assets/generic-property.svg`. Backup creation uses SQLite's online backup API, then asynchronously copies property files, images, and integration settings into `/data/property-backups/<timestamp>`.

The in-app backup is useful for quick restore points, but production deployment should also run `deploy/scripts/backup.sh`, copy encrypted backups to another physical device, and test `deploy/scripts/restore.sh` periodically. Stop the application before a manual restore.

## Security Checklist

- Publish the tenant portal only behind HTTPS.
- Set `EMAIL_CLIENT_PUBLIC_URL` to the exact public origin.
- Keep direct port `3001` inaccessible when using a reverse proxy.
- Change the bootstrap administrator PIN and use strong tenant passwords.
- Restrict `/data`, `deploy/.env`, and backup ACLs.
- Keep provider credentials in Admin settings or environment variables, never source control.
- Enable SMS only after documenting consent language and opt-out handling.
- Test Stripe and PayPal in sandbox/test mode before switching to live credentials.
- Back up before upgrades and regularly perform a restore drill.
- Do not run two containers against the same SQLite data directory.

## Current Scope and Remaining Production Work

This implementation is intended for one private installation and a small portfolio. Before operating it as a commercial property-management SaaS or serving unrelated landlords, complete legal, accounting, and security review. The largest remaining product expansions are:

- email verification, password reset, manager MFA, and CSRF tokens for a broad public deployment;
- multiple lease parties, co-signers, deposits held in dedicated trust-account workflows, late-fee policy engines, and lease renewals;
- vendor accounts, work orders, estimates, invoices, inspections, and recurring maintenance;
- e-signature integration and malware scanning for external uploads;
- charge disputes, chargebacks, bank reconciliation, owner statements, tax reports, and accounting-system integrations;
- quiet hours and organization-editable notification templates;
- accessibility audit, automated browser acceptance tests, security review, and disaster-recovery drill;
- PostgreSQL plus separate workers before multi-instance scale;
- Stripe Connect before routing money for multiple independent landlords.

AI may later suggest property links, categories, service requests, reminders, or response drafts. It must remain reviewable and must not send legal notices, apply fees, change leases, or initiate payments without explicit authorized approval.
