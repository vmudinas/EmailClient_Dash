# Property Management Expansion Plan

## Purpose

Archive Mail currently combines private email archives, Gmail synchronization, calendars, to-dos, drafts, AI review, rules, and administration in one React/Fastify application. This plan expands it into a multi-page personal operations platform while preserving Mail as a focused module.

The new Property Management module should let a property owner or manager:

- create houses and units;
- invite tenants into private portal accounts;
- create and manage leases;
- upload, preview, share, and audit rental agreements and related documents;
- receive, assign, and track service requests;
- generate rent charges and track balances;
- accept rent payments safely through a payment provider;
- send configurable email, SMS, and in-app reminders;
- retain a complete audit trail without exposing the manager's private mailbox to tenants.

## Product Shape

Build one application with a shared authenticated shell and separate modules:

1. **Mail** — the current archive and Gmail experience.
2. **Calendar** — current calendars and to-dos.
3. **Property Management** — manager-facing properties, leases, requests, payments, documents, and communications.
4. **Tenant Portal** — tenant-only home, payments, requests, documents, and profile pages.
5. **Administration** — users, integrations, templates, security, audit, and system configuration.

Property data must not be implemented as another email folder hierarchy. Mail remains private to its owner. A manager may explicitly link an email or attachment to a property, lease, payment, or service request, but that action must copy or reference only the selected item and must not grant mailbox access.

## Navigation and Pages

The current web application switches between Mail and Calendar with local component state. Replace that with URL-based routing and a reusable application shell.

### Manager routes

| Route | Purpose |
| --- | --- |
| `/dashboard` | Portfolio summary, rent due, overdue balances, expiring leases, and open requests. |
| `/mail` | Existing Archive Mail experience. |
| `/calendar` | Existing calendar and to-do experience. |
| `/properties` | Search, create, and manage houses and units. |
| `/properties/:propertyId` | Property overview, occupants, lease, documents, requests, and financial history. |
| `/tenants` | Tenant directory, invitations, contact details, and active leases. |
| `/leases` | Draft, active, upcoming, expired, and renewal workflows. |
| `/requests` | Service-request board with assignment, priority, status, and aging. |
| `/payments` | Charges, balances, payment attempts, receipts, failures, and reconciliation. |
| `/documents` | Agreements, notices, inspections, receipts, and access history. |
| `/communications` | Reminder rules, templates, delivery history, and consent status. |
| `/settings` | Personal and organization settings. |

### Tenant routes

| Route | Purpose |
| --- | --- |
| `/portal` | Current home, lease summary, balance, next due date, and open requests. |
| `/portal/payments` | Pay rent, view charges, download receipts, and review payment history. |
| `/portal/requests` | Create, comment on, and track service requests. |
| `/portal/documents` | View and download documents shared through the tenant's lease. |
| `/portal/messages` | Property notices and notification history. |
| `/portal/profile` | Contact details, password, notification preferences, and SMS consent. |

Desktop navigation should use a module switcher and a module-specific side panel. Mobile navigation should show only the actions relevant to the active role and module.

## Identity, Roles, and Authorization

Keep `users` as the global identity table, but do not use one global role to authorize every property operation. Add organization memberships and property/lease relationships.

Recommended roles:

- **System administrator** — manages the installation and global integrations.
- **Organization owner** — controls an organization's properties, managers, billing configuration, and templates.
- **Property manager** — manages assigned properties, leases, requests, documents, and charges.
- **Tenant** — sees only leases, units, documents, charges, and requests available through their membership.
- **Maintenance user** — optional role limited to assigned service requests.

Authorization rules must be enforced in Fastify before loading or mutating a resource:

- private mail resources continue using `owner_user_id`;
- property resources use `organization_id` and, where relevant, `property_id`;
- tenant access is derived from an active or historically relevant lease-party record;
- document access requires an explicit visibility rule or lease assignment;
- maintenance users cannot see rent, payment, or unrelated tenant data;
- returning `404` instead of `403` for inaccessible resource IDs prevents existence disclosure;
- every privileged action writes an audit event.

Do not expose the current short PIN flow directly to the public internet. Before tenant launch, add verified email, password or magic-link authentication, secure HTTP-only session cookies, password reset, optional multi-factor authentication for managers, CSRF protection, and public-login rate limiting.

## Domain Model

### Organizations and properties

- `organizations`
- `organization_members`
- `properties`
- `units`
- `property_contacts`
- `property_assignments`

Represent a single-family house as one property containing one unit. This supports apartments and multi-unit buildings later without changing the lease model.

### Tenants and leases

- `tenant_profiles`
- `tenant_invitations`
- `leases`
- `lease_parties`
- `lease_terms`
- `rent_schedules`
- `security_deposits`

A lease may have multiple tenants. Preserve historical memberships after move-out so former tenants can access only the documents and receipts that policy allows.

### Documents

- `documents`
- `document_versions`
- `document_assignments`
- `document_acknowledgements`
- `document_access_events`

Reuse the content-addressed blob store, but generalize file metadata beyond resumes and email attachments. Files need authenticated preview/download endpoints, MIME validation, size limits, SHA-256 integrity, version history, visibility controls, and access auditing. Malware scanning can be added before broader external uploads are enabled.

### Service requests

- `service_requests`
- `service_request_comments`
- `service_request_attachments`
- `service_request_assignments`
- `service_request_status_history`

Suggested statuses: `submitted`, `triaged`, `scheduled`, `in_progress`, `waiting`, `completed`, and `cancelled`. Status history should be immutable. Tenants may add comments and attachments but may not rewrite manager notes or historical events.

### Rent and payments

- `rent_charges`
- `charge_adjustments`
- `payment_attempts`
- `payment_allocations`
- `ledger_entries`
- `payment_provider_events`
- `receipts`

The monthly rent schedule generates dated charges. Payments are allocated to charges through immutable ledger entries. Correct mistakes with adjustments rather than rewriting completed financial records.

Store provider customer, Checkout Session, Payment Intent, charge, refund, and event identifiers. Never store complete card numbers, bank-account numbers, or provider secrets in application tables.

### Notifications

- `notification_preferences`
- `notification_templates`
- `notification_rules`
- `notification_jobs`
- `delivery_attempts`
- `communication_consents`
- `in_app_notifications`

Notification jobs must be durable database records rather than process-only timers. Every job needs an idempotency key, scheduled time, status, attempt count, next retry time, provider ID, and final result.

## Core Workflows

### Property and tenant onboarding

1. Manager creates an organization, property, and unit.
2. Manager enters tenant contact details and sends a time-limited invitation.
3. Tenant verifies their email and creates secure credentials.
4. Manager creates lease dates, rent amount, due day, deposit, and reminder policy.
5. Manager uploads the rental agreement and shares it with lease parties.
6. Tenant can view or acknowledge the agreement without seeing unrelated documents or mail.

### Monthly rent cycle

1. A durable scheduled job generates the next rent charge exactly once.
2. Reminder jobs are created from the lease policy, for example seven days before, three days before, due date, and overdue.
3. Tenant opens the hosted payment flow from the portal.
4. The provider collects card or ACH authorization; Archive Mail never receives raw payment credentials.
5. A signature-verified webhook stores the provider event and updates the payment attempt idempotently.
6. Successful funds are allocated to the charge and a receipt becomes available.
7. Delayed, failed, refunded, or disputed payments remain visible and trigger appropriate notifications.

For the initial single-owner deployment, use the owner's normal Stripe account. Consider Stripe Connect only if the product later serves unrelated landlords and routes money to multiple independent recipients.

ACH is a delayed and disputable payment method. Do not mark rent paid from the browser return URL. The webhook-confirmed provider state is authoritative.

References:

- [Stripe ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit)
- [Stripe webhook signature verification](https://docs.stripe.com/webhooks?lang=node)

### Service requests

1. Tenant selects a category and adds description, preferred entry time, and attachments.
2. System confirms submission and notifies assigned managers.
3. Manager sets priority, assignment, target date, and status.
4. Comments and status changes create an auditable timeline.
5. Tenant receives portal, email, or consented SMS updates.
6. Tenant may confirm completion or reopen according to policy.

### Email and SMS reminders

Use a provider-neutral notification service:

- existing Gmail sending for initial transactional email;
- Twilio Messaging Service for optional SMS;
- in-app notifications for every tenant account;
- template variables scoped to organization, property, unit, lease, charge, and request;
- delivery logs with retry and failure information.

SMS must remain opt-in. Store the consent source, wording, timestamp, phone number, and revocation status. Process STOP-like messages immediately and suppress future deliveries.

References:

- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy)
- [Twilio Consent Management API](https://www.twilio.com/docs/messaging/features/consent-api)

## Technical Architecture

### Web application

- Add React Router and route guards.
- Introduce `AppShell`, `ModuleSwitcher`, `ManagerNavigation`, and `TenantNavigation`.
- Extract current Mail state and effects from `App.tsx` into a `/mail` route and mail-specific hooks.
- Keep route components lazy-loaded so the Property module does not increase initial Mail startup cost.
- Split API clients by domain: `mailApi`, `propertyApi`, `tenantApi`, `paymentApi`, and `adminApi`.
- Preserve responsive layouts and implement tenant pages mobile-first.

### API application

- Split route registration into domain modules instead of continuing to grow `app.ts`.
- Add property repositories/services behind explicit interfaces.
- Add centralized organization/resource authorization helpers.
- Expose payment and messaging webhook routes separately from authenticated UI routes.
- Verify webhook signatures before parsing or applying events.
- Require idempotency for charge generation, provider events, reminders, and receipts.

### Database and jobs

SQLite remains suitable for a small, single-instance NAS deployment when kept on a local volume with WAL and tested backups. Use short transactions and indexes beginning with `organization_id` or the primary resource scope.

Critical property jobs must be persisted in SQLite. A scheduler may run in the API process initially, but it must claim jobs transactionally with a lease/lock time so restarts and duplicate workers cannot send duplicate reminders or create duplicate rent charges.

Move to PostgreSQL before multi-instance deployment or materially higher concurrent write volume. Do not advertise PostgreSQL support until the property repositories, migrations, search, tests, backup, and restore paths are implemented for it.

### Deployment

The existing Synology container can host an early single-owner version. Tenant access and provider webhooks require:

- a stable public hostname;
- HTTPS through a trusted reverse proxy;
- secure secrets management;
- public webhook endpoints for payments and SMS;
- tested automated backups and restore drills;
- monitoring for failed jobs, failed webhooks, and disk usage;
- a clear privacy policy and appropriate legal review for leases, rent, fees, and communications.

## Delivery Phases

### Phase 1 — Application shell

- Add URL routing and route-level authorization.
- Extract Mail and Calendar into independent route modules.
- Add desktop and mobile module navigation.
- Preserve all existing Mail behavior and tests.

**Exit criteria:** refreshing `/mail` or `/calendar` restores the correct page; unauthorized modules do not appear or load.

### Phase 2 — Property foundation

- Add organizations, memberships, properties, units, and assignments.
- Add manager property list, create/edit forms, and property detail page.
- Add ownership and cross-organization isolation tests.

**Exit criteria:** two managers cannot access each other's property IDs, units, or dashboard counts.

### Phase 3 — Tenant accounts and leases

- Add tenant invitations and hardened public authentication.
- Add tenant profiles, leases, lease parties, and rent schedules.
- Add the tenant home page and manager tenant/lease pages.

**Exit criteria:** invited tenants see only their active or explicitly retained historical lease data.

### Phase 4 — Documents

- Generalize blob storage and add document metadata, versions, assignments, and auditing.
- Add manager upload/preview/share flows.
- Add tenant view/download/acknowledge flows.

**Exit criteria:** direct document IDs cannot bypass lease or organization permissions; backups include every document blob and metadata row.

### Phase 5 — Service requests

- Add tenant submission, attachments, comments, and status tracking.
- Add manager board, assignment, filtering, priority, and notifications.
- Add optional maintenance-user access.

**Exit criteria:** requests have complete history and tenants receive only updates for their own unit.

### Phase 6 — Rent ledger and email reminders

- Generate recurring charges idempotently.
- Add balances, adjustments, receipts, and overdue state.
- Add durable notification jobs and email templates.

**Exit criteria:** restarts cannot duplicate charges or reminders; every balance can be reconstructed from ledger entries.

### Phase 7 — Stripe payments

- Add hosted Checkout, card and ACH options, webhook verification, refunds, reconciliation, and payment audit history.
- Add test-mode simulations for success, delay, failure, refund, and dispute.

**Exit criteria:** browser redirects never mark charges paid; replayed webhook events produce no duplicate ledger entries.

### Phase 8 — SMS and production hardening

- Add Twilio configuration, consent, STOP handling, quiet hours, retries, and delivery history.
- Add monitoring, security review, restore test, accessibility review, and mobile acceptance testing.

**Exit criteria:** opted-out numbers are suppressed, failed deliveries are visible, and a complete environment can be restored from backup.

## Recommended MVP

The safest useful MVP is Phases 1 through 6:

- multi-page shell;
- properties and units;
- tenant invitations and leases;
- document sharing;
- service requests;
- rent ledger;
- email reminders.

Add live payments and SMS only after tenant isolation, public authentication, HTTPS, backups, and durable background jobs are proven. This keeps the first release valuable without introducing payment and messaging compliance before the core tenancy model is stable.

## Deferred Enhancements

- AI extraction of property, tenant, invoice, and service-request details from selected emails;
- reviewable AI draft replies for tenant communications;
- lease renewal workflows and e-signature provider integration;
- vendor directory and work-order billing;
- inspection checklists and recurring maintenance;
- owner statements and accounting exports;
- multiple independent landlord organizations through Stripe Connect;
- PostgreSQL and multi-instance workers;
- native mobile applications.

AI automation should remain reviewable. It may recommend links, categories, requests, reminders, or drafts, but it must not send legal notices, apply fees, change leases, or initiate payments without explicit authorized approval.
