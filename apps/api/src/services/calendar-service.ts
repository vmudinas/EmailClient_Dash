import { randomUUID } from "node:crypto";
import type {
  AppleCalendarAccountCreate,
  CalendarAccount,
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventInput,
  CalendarSource
} from "@email-client/shared";
import ICAL from "ical.js";
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import type { EmailStore, CalendarAccountRecord } from "../storage/database.js";
import type { GmailService } from "./gmail-service.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_CALENDAR_COLOR = "#15805f";
const DEFAULT_APPLE_COLOR = "#ff3b30";

interface GoogleEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEventAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
}

interface GoogleEventOrganizer {
  email?: string;
  displayName?: string;
}

interface GoogleConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
}

interface GoogleConferenceData {
  entryPoints?: GoogleConferenceEntryPoint[];
}

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  htmlLink?: string;
  status?: string;
  hangoutLink?: string;
  conferenceData?: GoogleConferenceData;
  organizer?: GoogleEventOrganizer;
  attendees?: GoogleEventAttendee[];
}

interface GoogleEventListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
}

interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
}

interface SourceIdentity {
  provider: "google" | "apple";
  accountId: string;
  externalId: string;
}

interface AppleEventIdentity {
  url: string;
  uid: string;
  recurrenceId: string | null;
}

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
type DavClientFactory = typeof createDAVClient;

export class CalendarService {
  constructor(
    private readonly gmail: GmailService,
    private readonly database: EmailStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly davClientFactory: DavClientFactory = createDAVClient
  ) {}

  async listSources(): Promise<CalendarSource[]> {
    const googleConnections = this.database.listGmailConnections()
      .filter((connection) => connection.canManageCalendar);
    const appleAccounts = this.database.listCalendarAccounts();
    const googleResults = await Promise.allSettled(
      googleConnections.map((connection) => this.listGoogleSources(connection.id, connection.email))
    );
    const googleSources = googleResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);

    const appleResults = await Promise.allSettled(
      appleAccounts.map((account) => this.listAppleSources(account.id))
    );
    const appleSources = appleResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const sources = [...googleSources, ...appleSources];
    const failures = [
      ...googleResults.flatMap((result, index) => result.status === "rejected"
        ? [`Google ${googleConnections[index]?.email ?? "Calendar"}: ${errorText(result.reason, "Could not list calendars")}`]
        : []),
      ...appleResults.flatMap((result, index) => result.status === "rejected"
        ? [`Apple ${appleAccounts[index]?.label ?? "Calendar"}: ${errorText(result.reason, "Could not list calendars")}`]
        : [])
    ];
    if (sources.length === 0 && failures.length > 0) {
      throw new Error(`Calendar sources could not be loaded. ${failures.join(" ")}`);
    }
    return sources;
  }

  async connectAppleAccount(input: AppleCalendarAccountCreate): Promise<CalendarAccount> {
    const client = await this.createAppleClient({
      id: "pending",
      provider: "apple",
      label: input.label,
      username: input.username,
      serverUrl: input.serverUrl,
      secret: input.appSpecificPassword,
      status: "connected",
      lastError: null,
      createdAt: "",
      updatedAt: ""
    });
    await client.fetchCalendars();
    return this.database.createCalendarAccount({
      label: input.label,
      username: input.username,
      serverUrl: input.serverUrl,
      secret: input.appSpecificPassword
    });
  }

  listAppleAccounts(): CalendarAccount[] {
    return this.database.listCalendarAccounts();
  }

  disconnectAppleAccount(accountId: string): CalendarAccount | null {
    return this.database.deleteCalendarAccount(accountId);
  }

  async listSourceEvents(sourceId: string, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const source = decodeSourceId(sourceId);
    if (source.provider === "google") {
      return this.listGoogleEvents(source, timeMinISO, timeMaxISO);
    }
    return this.listAppleEvents(source, timeMinISO, timeMaxISO);
  }

  async createSourceEvent(sourceId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const source = decodeSourceId(sourceId);
    if (source.provider === "google") return this.createGoogleEvent(source, input);
    return this.createAppleEvent(source, input);
  }

  async updateSourceEvent(sourceId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const source = decodeSourceId(sourceId);
    if (source.provider === "google") return this.updateGoogleEvent(source, eventId, input);
    return this.updateAppleEvent(source, eventId, input);
  }

  async deleteSourceEvent(sourceId: string, eventId: string): Promise<void> {
    const source = decodeSourceId(sourceId);
    if (source.provider === "google") {
      await this.deleteGoogleEvent(source, eventId);
      return;
    }
    await this.deleteAppleEvent(source, eventId);
  }

  async listEvents(connectionId: string, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    return this.listGoogleEvents({ provider: "google", accountId: connectionId, externalId: "primary" }, timeMinISO, timeMaxISO);
  }

  async createEvent(connectionId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.createGoogleEvent({ provider: "google", accountId: connectionId, externalId: "primary" }, input);
  }

  async updateEvent(connectionId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.updateGoogleEvent({ provider: "google", accountId: connectionId, externalId: "primary" }, eventId, input);
  }

  async deleteEvent(connectionId: string, eventId: string): Promise<void> {
    return this.deleteGoogleEvent({ provider: "google", accountId: connectionId, externalId: "primary" }, eventId);
  }

  private async listGoogleSources(connectionId: string, email: string): Promise<CalendarSource[]> {
    const signal = AbortSignal.timeout(20_000);
    const accessToken = await this.gmail.accessTokenForConnection(connectionId, signal);
    const entries: GoogleCalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("showHidden", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.calendarJson<GoogleCalendarListResponse>(url.toString(), accessToken, signal);
      entries.push(...(page.items ?? []).filter((entry) => !entry.deleted));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return entries.map((entry) => ({
      id: encodeSourceId({ provider: "google", accountId: connectionId, externalId: entry.id }),
      provider: "google",
      accountId: connectionId,
      accountLabel: email,
      externalId: entry.id,
      name: entry.summaryOverride || entry.summary || email,
      color: safeColor(entry.backgroundColor, DEFAULT_CALENDAR_COLOR),
      readOnly: entry.accessRole === "reader" || entry.accessRole === "freeBusyReader",
      primary: Boolean(entry.primary),
      selectedByDefault: Boolean(entry.primary || entry.selected)
    }));
  }

  private async listGoogleEvents(source: SourceIdentity, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const signal = AbortSignal.timeout(20_000);
    const accessToken = await this.gmail.accessTokenForConnection(source.accountId, signal);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(source.externalId)}/events`);
      url.searchParams.set("timeMin", timeMinISO);
      url.searchParams.set("timeMax", timeMaxISO);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "250");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.calendarJson<GoogleEventListResponse>(url.toString(), accessToken, signal);
      for (const item of page.items ?? []) {
        if (item.status === "cancelled") continue;
        events.push(toGoogleCalendarEvent(source, item));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  private async createGoogleEvent(source: SourceIdentity, input: CalendarEventInput): Promise<CalendarEvent> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(source.accountId, signal);
    const created = await this.calendarJson<GoogleCalendarEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(source.externalId)}/events`,
      accessToken,
      signal,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(input))
      }
    );
    return toGoogleCalendarEvent(source, created);
  }

  private async updateGoogleEvent(source: SourceIdentity, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(source.accountId, signal);
    const updated = await this.calendarJson<GoogleCalendarEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(source.externalId)}/events/${encodeURIComponent(eventId)}`,
      accessToken,
      signal,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(input))
      }
    );
    return toGoogleCalendarEvent(source, updated);
  }

  private async deleteGoogleEvent(source: SourceIdentity, eventId: string): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(source.accountId, signal);
    const response = await this.fetcher(
      `${CALENDAR_API}/calendars/${encodeURIComponent(source.externalId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` }, signal }
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Calendar event could not be deleted (${response.status})`);
    }
  }

  private async listAppleSources(accountId: string): Promise<CalendarSource[]> {
    const account = this.appleAccount(accountId);
    try {
      const client = await this.createAppleClient(account);
      const calendars = await client.fetchCalendars();
      this.database.updateCalendarAccountStatus(account.id, "connected", null);
      return calendars.map((calendar, index) => ({
        id: encodeSourceId({ provider: "apple", accountId, externalId: calendar.url }),
        provider: "apple",
        accountId,
        accountLabel: account.label,
        externalId: calendar.url,
        name: calendarName(calendar, account.label),
        color: safeColor(calendar.calendarColor, DEFAULT_APPLE_COLOR),
        readOnly: false,
        primary: index === 0,
        selectedByDefault: true
      }));
    } catch (error) {
      const message = errorText(error, "Apple Calendar authorization failed");
      this.database.updateCalendarAccountStatus(account.id, "error", message);
      throw new Error(message);
    }
  }

  private async listAppleEvents(source: SourceIdentity, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const { account, client, calendar } = await this.appleContext(source);
    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: timeMinISO, end: timeMaxISO },
      expand: true
    });
    const sourceId = encodeSourceId(source);
    return objects.flatMap((object) => appleEventsFromObject(
      object,
      sourceId,
      account.id,
      calendarName(calendar, account.label),
      safeColor(calendar.calendarColor, DEFAULT_APPLE_COLOR)
    ));
  }

  private async createAppleEvent(source: SourceIdentity, input: CalendarEventInput): Promise<CalendarEvent> {
    const { account, client, calendar } = await this.appleContext(source);
    const uid = randomUUID();
    const iCalString = createAppleCalendarData(uid, input);
    const response = await client.createCalendarObject({ calendar, iCalString, filename: `${uid}.ics` });
    assertDavResponse(response, "Apple Calendar event could not be created");
    return appleEventFromInput(
      source,
      encodeAppleEventId({ url: new URL(`${uid}.ics`, calendar.url).toString(), uid, recurrenceId: null }),
      input,
      calendarName(calendar, account.label),
      safeColor(calendar.calendarColor, DEFAULT_APPLE_COLOR)
    );
  }

  private async updateAppleEvent(source: SourceIdentity, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const identity = decodeAppleEventId(eventId);
    const { account, client, calendar } = await this.appleContext(source);
    const [object] = await client.fetchCalendarObjects({ calendar, objectUrls: [identity.url] });
    if (!object?.data) throw new Error("Apple Calendar event was not found");
    const root = ICAL.Component.fromString(String(object.data));
    const eventComponent = findAppleEventComponent(root, identity);
    if (!eventComponent) throw new Error("Apple Calendar event was not found");
    applyAppleEventInput(new ICAL.Event(eventComponent), input);
    const calendarObject: DAVCalendarObject = { ...object, data: root.toString() };
    const response = await client.updateCalendarObject({ calendarObject });
    assertDavResponse(response, "Apple Calendar event could not be updated");
    return appleEventFromInput(
      source,
      eventId,
      input,
      calendarName(calendar, account.label),
      safeColor(calendar.calendarColor, DEFAULT_APPLE_COLOR)
    );
  }

  private async deleteAppleEvent(source: SourceIdentity, eventId: string): Promise<void> {
    const identity = decodeAppleEventId(eventId);
    const { client } = await this.appleContext(source);
    const response = await client.deleteCalendarObject({ calendarObject: { url: identity.url } });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Apple Calendar event could not be deleted (${response.status})`);
    }
  }

  private async appleContext(source: SourceIdentity): Promise<{
    account: CalendarAccountRecord;
    client: DavClient;
    calendar: DAVCalendar;
  }> {
    const account = this.appleAccount(source.accountId);
    const client = await this.createAppleClient(account);
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find((entry) => entry.url === source.externalId);
    if (!calendar) throw new Error("Apple calendar was not found");
    this.database.updateCalendarAccountStatus(account.id, "connected", null);
    return { account, client, calendar };
  }

  private appleAccount(accountId: string): CalendarAccountRecord {
    const account = this.database.getCalendarAccountRecord(accountId);
    if (!account) throw new Error("Apple Calendar account was not found");
    return account;
  }

  private createAppleClient(account: CalendarAccountRecord): Promise<DavClient> {
    return this.davClientFactory({
      serverUrl: account.serverUrl,
      credentials: { username: account.username, password: account.secret },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: this.fetcher
    });
  }

  private async calendarJson<T>(
    url: string,
    accessToken: string,
    signal: AbortSignal,
    init: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    const response = await this.fetcher(url, { ...init, headers, signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(remoteErrorMessage(body) ?? `Calendar request failed (${response.status})`);
    }
    return body as T;
  }
}

function remoteErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  return typeof nested?.message === "string" ? nested.message : null;
}

function toGoogleEvent(input: CalendarEventInput): Record<string, unknown> {
  return {
    summary: input.title,
    description: input.description || undefined,
    location: input.location || undefined,
    start: input.allDay ? { date: input.startAt } : { dateTime: input.startAt },
    end: input.allDay ? { date: addDaysToDateString(input.endAt, 1) } : { dateTime: input.endAt }
  };
}

function toGoogleCalendarEvent(source: SourceIdentity, event: GoogleCalendarEvent): CalendarEvent {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    connectionId: source.accountId,
    sourceId: encodeSourceId(source),
    provider: "google",
    title: event.summary ?? "(No title)",
    description: event.description ?? "",
    location: event.location ?? "",
    startAt: event.start?.dateTime ?? event.start?.date ?? "",
    endAt: allDay && event.end?.date
      ? addDaysToDateString(event.end.date, -1)
      : event.end?.dateTime ?? event.end?.date ?? "",
    allDay,
    htmlLink: event.htmlLink ?? null,
    meetingLink: event.hangoutLink ?? conferenceVideoLink(event.conferenceData) ?? null,
    organizer: event.organizer?.email
      ? { email: event.organizer.email, displayName: event.organizer.displayName ?? null }
      : null,
    attendees: (event.attendees ?? [])
      .filter((attendee) => attendee.email && !attendee.resource)
      .map((attendee): CalendarEventAttendee => ({
        email: attendee.email!,
        displayName: attendee.displayName ?? null,
        responseStatus: normalizeResponseStatus(attendee.responseStatus),
        organizer: Boolean(attendee.organizer),
        self: Boolean(attendee.self)
      }))
  };
}

function appleEventsFromObject(
  object: DAVCalendarObject,
  sourceId: string,
  accountId: string,
  calendarNameValue: string,
  calendarColor: string
): CalendarEvent[] {
  if (!object.data) return [];
  try {
    const root = ICAL.Component.fromString(String(object.data));
    return root.getAllSubcomponents("vevent").map((component) => {
      const event = new ICAL.Event(component);
      const recurrenceId = component.getFirstPropertyValue("recurrence-id");
      const allDay = event.startDate.isDate;
      const organizerValue = stripMailto(event.organizer || "");
      return {
        id: encodeAppleEventId({
          url: object.url,
          uid: event.uid,
          recurrenceId: recurrenceId ? String(recurrenceId) : null
        }),
        connectionId: accountId,
        sourceId,
        provider: "apple",
        calendarName: calendarNameValue,
        calendarColor,
        title: event.summary || "(No title)",
        description: event.description || "",
        location: event.location || "",
        startAt: allDay ? event.startDate.toString().slice(0, 10) : event.startDate.toJSDate().toISOString(),
        endAt: allDay
          ? addDaysToDateString(event.endDate.toString().slice(0, 10), -1)
          : event.endDate.toJSDate().toISOString(),
        allDay,
        htmlLink: null,
        meetingLink: meetingLinkFromComponent(component),
        organizer: organizerValue ? { email: organizerValue, displayName: organizerName(component) } : null,
        attendees: component.getAllProperties("attendee").flatMap((property): CalendarEventAttendee[] => {
          const email = stripMailto(String(property.getFirstValue() ?? ""));
          if (!email) return [];
          return [{
            email,
            displayName: stringParameter(property.getParameter("cn")),
            responseStatus: normalizeResponseStatus(stringParameter(property.getParameter("partstat"))?.toLowerCase()),
            organizer: organizerValue.toLowerCase() === email.toLowerCase(),
            self: false
          }];
        })
      };
    });
  } catch {
    return [];
  }
}

function createAppleCalendarData(uid: string, input: CalendarEventInput): string {
  const root = new ICAL.Component("vcalendar");
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("prodid", "-//Archive Mail//Calendar//EN");
  root.addPropertyWithValue("calscale", "GREGORIAN");
  const component = new ICAL.Component("vevent");
  root.addSubcomponent(component);
  const event = new ICAL.Event(component);
  event.uid = uid;
  component.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  applyAppleEventInput(event, input);
  return root.toString();
}

function applyAppleEventInput(event: InstanceType<typeof ICAL.Event>, input: CalendarEventInput): void {
  event.summary = input.title;
  event.description = input.description;
  event.location = input.location;
  event.startDate = input.allDay
    ? ICAL.Time.fromDateString(input.startAt)
    : ICAL.Time.fromJSDate(new Date(input.startAt), true);
  event.endDate = input.allDay
    ? ICAL.Time.fromDateString(addDaysToDateString(input.endAt, 1))
    : ICAL.Time.fromJSDate(new Date(input.endAt), true);
  event.sequence = Number.isFinite(event.sequence) ? event.sequence + 1 : 0;
}

function appleEventFromInput(
  source: SourceIdentity,
  eventId: string,
  input: CalendarEventInput,
  calendarNameValue: string,
  calendarColor: string
): CalendarEvent {
  return {
    id: eventId,
    connectionId: source.accountId,
    sourceId: encodeSourceId(source),
    provider: "apple",
    calendarName: calendarNameValue,
    calendarColor,
    ...input,
    htmlLink: null,
    meetingLink: null,
    organizer: null,
    attendees: []
  };
}

function findAppleEventComponent(root: InstanceType<typeof ICAL.Component>, identity: AppleEventIdentity) {
  return root.getAllSubcomponents("vevent").find((component) => {
    const event = new ICAL.Event(component);
    const recurrenceId = component.getFirstPropertyValue("recurrence-id");
    return event.uid === identity.uid && (recurrenceId ? String(recurrenceId) : null) === identity.recurrenceId;
  }) ?? null;
}

function meetingLinkFromComponent(component: InstanceType<typeof ICAL.Component>): string | null {
  const url = component.getFirstPropertyValue("url");
  if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  const description = String(component.getFirstPropertyValue("description") ?? "");
  return description.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? null;
}

function organizerName(component: InstanceType<typeof ICAL.Component>): string | null {
  return stringParameter(component.getFirstProperty("organizer")?.getParameter("cn"));
}

function stringParameter(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function stripMailto(value: string): string {
  return value.replace(/^mailto:/i, "").trim();
}

function calendarName(calendar: DAVCalendar, fallback: string): string {
  return typeof calendar.displayName === "string" && calendar.displayName.trim()
    ? calendar.displayName.trim()
    : fallback;
}

function safeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.slice(0, 7) : fallback;
}

function assertDavResponse(response: Response, fallback: string): void {
  if (!response.ok) throw new Error(`${fallback} (${response.status})`);
}

function encodeSourceId(identity: SourceIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

function decodeSourceId(value: string): SourceIdentity {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SourceIdentity>;
    if ((parsed.provider === "google" || parsed.provider === "apple")
      && typeof parsed.accountId === "string" && parsed.accountId
      && typeof parsed.externalId === "string" && parsed.externalId) {
      return parsed as SourceIdentity;
    }
  } catch {
    // Handled below.
  }
  throw new Error("Invalid calendar source");
}

function encodeAppleEventId(identity: AppleEventIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

function decodeAppleEventId(value: string): AppleEventIdentity {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AppleEventIdentity>;
    if (typeof parsed.url === "string" && parsed.url
      && typeof parsed.uid === "string" && parsed.uid
      && (typeof parsed.recurrenceId === "string" || parsed.recurrenceId === null)) {
      return parsed as AppleEventIdentity;
    }
  } catch {
    // Handled below.
  }
  throw new Error("Invalid Apple Calendar event");
}

function conferenceVideoLink(conferenceData?: GoogleConferenceData): string | null {
  const entryPoint = conferenceData?.entryPoints?.find((point) => point.entryPointType === "video");
  return entryPoint?.uri ?? null;
}

function normalizeResponseStatus(status?: string | null): CalendarEventAttendee["responseStatus"] {
  return status === "accepted" || status === "declined" || status === "tentative" ? status : "needsAction";
}

function addDaysToDateString(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
