import type { CalendarEvent, CalendarEventAttendee, CalendarEventInput } from "@email-client/shared";
import type { GmailService } from "./gmail-service.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

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

export class CalendarService {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly gmail: GmailService,
    fetcher: typeof fetch = fetch
  ) {
    this.fetcher = fetcher;
  }

  async listEvents(connectionId: string, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const signal = AbortSignal.timeout(20_000);
    const accessToken = await this.gmail.accessTokenForConnection(connectionId, signal);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
      url.searchParams.set("timeMin", timeMinISO);
      url.searchParams.set("timeMax", timeMaxISO);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "250");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.calendarJson<GoogleEventListResponse>(url.toString(), accessToken, signal);
      for (const item of page.items ?? []) {
        if (item.status === "cancelled") continue;
        events.push(toCalendarEvent(connectionId, item));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  async createEvent(connectionId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(connectionId, signal);
    const created = await this.calendarJson<GoogleCalendarEvent>(
      `${CALENDAR_API}/calendars/primary/events`,
      accessToken,
      signal,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(input))
      }
    );
    return toCalendarEvent(connectionId, created);
  }

  async updateEvent(connectionId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(connectionId, signal);
    const updated = await this.calendarJson<GoogleCalendarEvent>(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      accessToken,
      signal,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(input))
      }
    );
    return toCalendarEvent(connectionId, updated);
  }

  async deleteEvent(connectionId: string, eventId: string): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.gmail.accessTokenForConnection(connectionId, signal);
    const response = await this.fetcher(`${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Calendar event could not be deleted (${response.status})`);
    }
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

function toCalendarEvent(connectionId: string, event: GoogleCalendarEvent): CalendarEvent {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    connectionId,
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

function conferenceVideoLink(conferenceData?: GoogleConferenceData): string | null {
  const entryPoint = conferenceData?.entryPoints?.find((point) => point.entryPointType === "video");
  return entryPoint?.uri ?? null;
}

function normalizeResponseStatus(status?: string): CalendarEventAttendee["responseStatus"] {
  return status === "accepted" || status === "declined" || status === "tentative" ? status : "needsAction";
}

function addDaysToDateString(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
