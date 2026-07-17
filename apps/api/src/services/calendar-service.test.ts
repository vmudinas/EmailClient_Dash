import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createDAVClient } from "tsdav";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
import { CalendarService } from "./calendar-service.js";
import { GmailPermissionError, GmailService } from "./gmail-service.js";
import { ImportService } from "./import-service.js";

const directories: string[] = [];
const services: Array<{ gmail: GmailService; imports: ImportService; database: EmailDatabase }> = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.gmail.close();
    await service.imports.close();
    service.database.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setUp(canManageCalendar: boolean, fetcher: typeof fetch) {
  const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-calendar-"));
  directories.push(dataDir);
  const database = new EmailDatabase(dataDir);
  const blobStore = new BlobStore(dataDir);
  const imports = new ImportService(database, blobStore);
  await imports.initialize();
  const archive = database.createArchive({
    name: "Gmail",
    sourceType: "gmail",
    fingerprint: "gmail-calendar",
    sizeBytes: 0
  });
  database.completeArchive(archive.id, 0);
  const folder = database.createFolder(archive.id, "Inbox");
  const connection = database.createGmailConnection({
    email: "owner@example.test",
    archiveId: archive.id,
    folderId: folder.id,
    query: "",
    ocrEnabled: false,
    canSend: false,
    canManageCalendar,
    refreshToken: "refresh-token"
  });
  const gmail = new GmailService(database, imports, {
    clientId: "desktop-client-id",
    clientSecret: null,
    redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
    fetcher
  });
  services.push({ gmail, imports, database });
  return { gmail, database, connectionId: connection.id };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("CalendarService", () => {
  it("lists, creates, updates, and deletes events on the primary calendar", async () => {
    const created: Record<string, unknown>[] = [];
    let updatedBody: Record<string, unknown> | null = null;
    let deleted = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events" && (!init || init.method === undefined)) {
        return jsonResponse({
          items: [
            {
              id: "event-1",
              summary: "Standup",
              start: { dateTime: "2026-07-15T09:00:00-04:00" },
              end: { dateTime: "2026-07-15T09:30:00-04:00" },
              htmlLink: "https://calendar.google.com/event-1",
              hangoutLink: "https://meet.google.com/abc-defg-hij",
              organizer: { email: "owner@example.test", displayName: "Owner" },
              attendees: [
                { email: "owner@example.test", displayName: "Owner", organizer: true, self: true, responseStatus: "accepted" },
                { email: "guest@example.test", responseStatus: "tentative" },
                { email: "room-1@resource.calendar.google.com", resource: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "event-cancelled",
              summary: "Cancelled sync",
              status: "cancelled"
            }
          ]
        });
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push(body);
        return jsonResponse({
          id: "event-2",
          summary: body.summary,
          start: body.start,
          end: body.end,
          htmlLink: "https://calendar.google.com/event-2"
        });
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events/event-2" && init?.method === "PATCH") {
        updatedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ id: "event-2", summary: "Renamed", start: updatedBody.start, end: updatedBody.end });
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events/event-2" && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected calendar test request: ${url} ${init?.method ?? "GET"}`);
    };
    const { gmail, database, connectionId } = await setUp(true, fetcher);
    const calendar = new CalendarService(gmail, database, fetcher);

    const events = await calendar.listEvents(connectionId, "2026-07-01T00:00:00.000Z", "2026-07-31T00:00:00.000Z");
    expect(events).toMatchObject([{
      id: "event-1",
      connectionId,
      provider: "google",
      title: "Standup",
      description: "",
      location: "",
      startAt: "2026-07-15T09:00:00-04:00",
      endAt: "2026-07-15T09:30:00-04:00",
      allDay: false,
      htmlLink: "https://calendar.google.com/event-1",
      meetingLink: "https://meet.google.com/abc-defg-hij",
      organizer: { email: "owner@example.test", displayName: "Owner" },
      attendees: [
        { email: "owner@example.test", displayName: "Owner", organizer: true, self: true, responseStatus: "accepted" },
        { email: "guest@example.test", displayName: null, organizer: false, self: false, responseStatus: "tentative" }
      ]
    }]);

    const createdEvent = await calendar.createEvent(connectionId, {
      title: "Team offsite",
      description: "",
      location: "",
      startAt: "2026-07-20",
      endAt: "2026-07-20",
      allDay: true
    });
    expect(createdEvent.id).toBe("event-2");
    expect(created[0]).toMatchObject({ start: { date: "2026-07-20" }, end: { date: "2026-07-21" } });

    const updated = await calendar.updateEvent(connectionId, "event-2", {
      title: "Renamed",
      description: "",
      location: "",
      startAt: "2026-07-20T10:00:00.000Z",
      endAt: "2026-07-20T11:00:00.000Z",
      allDay: false
    });
    expect(updated.title).toBe("Renamed");
    expect(updatedBody).toMatchObject({ summary: "Renamed" });

    await calendar.deleteEvent(connectionId, "event-2");
    expect(deleted).toBe(true);
  });

  it("refuses calendar access for a connection that has not granted the calendar scope", async () => {
    const { gmail, database, connectionId } = await setUp(false, async () => {
      throw new Error("Network must not be used without calendar permission");
    });
    const calendar = new CalendarService(gmail, database);

    await expect(calendar.listEvents(connectionId, "2026-07-01T00:00:00.000Z", "2026-07-31T00:00:00.000Z"))
      .rejects.toBeInstanceOf(GmailPermissionError);
  });

  it("discovers every Google calendar and preserves access and default-selection metadata", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [
          { id: "owner@example.test", summary: "Personal", primary: true, selected: true, backgroundColor: "#123456", accessRole: "owner" },
          { id: "team@example.test", summary: "Team", selected: true, backgroundColor: "#654321", accessRole: "reader" }
        ] });
      }
      throw new Error(`Unexpected calendar source request: ${url}`);
    };
    const { gmail, database } = await setUp(true, fetcher);
    const calendar = new CalendarService(gmail, database, fetcher);

    const sources = await calendar.listSources();

    expect(sources).toMatchObject([
      { provider: "google", name: "Personal", primary: true, readOnly: false, selectedByDefault: true, color: "#123456" },
      { provider: "google", name: "Team", primary: false, readOnly: true, selectedByDefault: true, color: "#654321" }
    ]);
  });

  it("reports provider discovery failures when no calendars can be loaded", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ error: { message: "Calendar API is disabled" } }, 403);
      }
      throw new Error(`Unexpected calendar source request: ${url}`);
    };
    const { gmail, database } = await setUp(true, fetcher);
    const calendar = new CalendarService(gmail, database, fetcher);

    await expect(calendar.listSources()).rejects.toThrow(/Calendar sources could not be loaded.*owner@example\.test/);
  });

  it("authorizes an Apple account and reads its CalDAV calendars and events", async () => {
    const { gmail, database } = await setUp(false, async () => {
      throw new Error("Google network must not be used");
    });
    const calendarObject = {
      url: "https://caldav.icloud.com/user/calendars/work/interview.ics",
      data: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:apple-event-1",
        "SUMMARY:Interview",
        "DTSTART:20260721T160000Z",
        "DTEND:20260721T170000Z",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\r\n")
    };
    const davClient = {
      fetchCalendars: vi.fn().mockResolvedValue([{
        url: "https://caldav.icloud.com/user/calendars/work/",
        displayName: "Work",
        calendarColor: "#ff3b30"
      }]),
      fetchCalendarObjects: vi.fn().mockResolvedValue([calendarObject]),
      createCalendarObject: vi.fn(),
      updateCalendarObject: vi.fn(),
      deleteCalendarObject: vi.fn()
    };
    const factory = vi.fn().mockResolvedValue(davClient) as unknown as typeof createDAVClient;
    const calendar = new CalendarService(gmail, database, fetch, factory);

    const account = await calendar.connectAppleAccount({
      label: "iCloud",
      username: "owner@icloud.test",
      appSpecificPassword: "abcd-efgh-ijkl-mnop",
      serverUrl: "https://caldav.icloud.com"
    });
    const sources = await calendar.listSources();
    const events = await calendar.listSourceEvents(
      sources[0]!.id,
      "2026-07-21T00:00:00.000Z",
      "2026-07-22T00:00:00.000Z"
    );

    expect(account).toMatchObject({ provider: "apple", label: "iCloud", username: "owner@icloud.test" });
    expect(sources).toMatchObject([{ provider: "apple", name: "Work", accountId: account.id }]);
    expect(events).toMatchObject([{ provider: "apple", title: "Interview", calendarName: "Work" }]);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      authMethod: "Basic",
      credentials: { username: "owner@icloud.test", password: "abcd-efgh-ijkl-mnop" }
    }));
  });
});
