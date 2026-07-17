import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
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

describe("GmailService", () => {
  it("imports raw Gmail MIME with attachments and deduplicates later pulls", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();

    const archive = database.createArchive({
      name: "Existing archive",
      sourceType: "mbox",
      fingerprint: "gmail-destination",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const folder = database.createFolder(archive.id, "Latest Gmail");
    const listQueries: string[] = [];
    let revoked = 0;
    let sentRaw: Buffer | null = null;
    let sentThreadId: string | null = null;
    const rawMime = gmailMessageFixture();
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events"
        });
      }
      if (url.toString().startsWith("https://oauth2.googleapis.com/revoke")) {
        revoked += 1;
        return jsonResponse({});
      }
      if (url.pathname.endsWith("/users/me/profile")) {
        return jsonResponse({ emailAddress: "owner@example.test" });
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        listQueries.push(url.searchParams.get("q") ?? "");
        return jsonResponse({ messages: [{ id: "gmail-message-1" }], resultSizeEstimate: 1 });
      }
      if (url.pathname.endsWith("/users/me/labels")) {
        return jsonResponse({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "SENT", name: "SENT", type: "system" },
            { id: "UNREAD", name: "UNREAD", type: "system" }
          ]
        });
      }
      if (url.pathname.endsWith("/users/me/messages/send")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
        const request = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
        sentRaw = Buffer.from(request.raw, "base64url");
        sentThreadId = request.threadId ?? null;
        return jsonResponse({ id: "gmail-sent-1", threadId: "gmail-thread-1" });
      }
      if (url.pathname.endsWith("/users/me/messages/gmail-message-1")) {
        return jsonResponse({
          id: "gmail-message-1",
          threadId: "gmail-thread-source",
          raw: rawMime.toString("base64url"),
          labelIds: ["INBOX", "UNREAD"]
        });
      }
      if (url.pathname.endsWith("/users/me/messages/gmail-sent-1")) {
        return jsonResponse({
          id: "gmail-sent-1",
          threadId: "gmail-thread-source",
          raw: sentRaw!.toString("base64url"),
          labelIds: ["SENT"]
        });
      }
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: "desktop-client-secret",
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    const authorization = gmail.startAuthorization({
      archiveId: archive.id,
      folderId: folder.id,
      archiveName: "Gmail",
      folderName: "Inbox",
      query: "newer_than:7d",
      ocrEnabled: false
    });
    const scopes = new URL(authorization.authorizationUrl).searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
    ]);
    expect(scopes).not.toContain("https://mail.google.com/");
    expect(new URL(authorization.authorizationUrl).searchParams.get("prompt"))
      .toBe("select_account consent");
    const state = new URL(authorization.authorizationUrl).searchParams.get("state")!;
    const connection = await gmail.finishAuthorization(state, "authorization-code");
    const firstSync = await waitForSync(database, connection.id);

    expect(firstSync).toMatchObject({
      status: "connected",
      processedItems: 1,
      totalItems: 1,
      importedItems: 1,
      canSend: true,
      canManageCalendar: false
    });
    expect(database.getArchive(archive.id)).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
      attachmentCount: 1
    });
    const hit = database.search({ q: "reconciliation workbook" }).items[0]!;
    expect(hit.matchedIn).toBe("attachment");
    expect(hit.matchedAttachmentName).toBe("gmail-notes.txt");
    const detail = database.getMessage(hit.message.id)!;
    expect(detail.folderPath).toBe("Latest Gmail/Inbox");
    expect(detail.attachments).toHaveLength(1);
    const stored = database.getAttachmentBlob(detail.attachments[0]!.id)!;
    expect((await blobStore.read(stored.relativePath)).toString("utf8")).toContain("reconciliation workbook");

    const sent = await gmail.sendMessage(connection.id, {
      to: ["recipient@example.test"],
      cc: ["copy@example.test"],
      bcc: [],
      subject: "Sent from Archive Mail",
      bodyText: "This local client sent the message through Gmail.",
      sourceMessageId: detail.id
    });
    expect(sent).toEqual({
      id: "gmail-sent-1",
      threadId: "gmail-thread-1",
      localCopyImported: true
    });
    const parsedSent = await simpleParser(sentRaw!);
    expect(parsedSent.from?.value[0]?.address).toBe("owner@example.test");
    expect(parsedSent.to?.value[0]?.address).toBe("recipient@example.test");
    expect(parsedSent.cc?.value[0]?.address).toBe("copy@example.test");
    expect(parsedSent.subject).toBe("Sent from Archive Mail");
    expect(parsedSent.text?.trim()).toBe("This local client sent the message through Gmail.");
    expect(parsedSent.inReplyTo).toBe("<gmail-message-1@example.test>");
    expect(parsedSent.references).toContain("<gmail-message-1@example.test>");
    expect(sentThreadId).toBe("gmail-thread-source");
    expect(database.getDraftReplyBlocker(detail.id)).toMatchObject({ reason: "already_replied" });
    expect(database.getArchive(archive.id)).toMatchObject({ messageCount: 2, unreadCount: 1 });
    expect(database.search({ q: "local client sent" }).items[0]?.message.state.isRead).toBe(true);

    gmail.startSync(connection.id);
    const secondSync = await waitForSync(database, connection.id);
    expect(secondSync.importedItems).toBe(0);
    expect(database.getArchive(archive.id)?.messageCount).toBe(2);
    expect(listQueries).toHaveLength(2);
    expect(listQueries[0]).toBe("newer_than:7d in:anywhere");
    expect(listQueries[1]).toContain("after:");
    expect(listQueries[1]).toContain("in:anywhere");
    expect(database.listDiagnostics().map((event) => event.message)).toContain(
      "Email sent from owner@example.test"
    );

    await gmail.removeConnection(connection.id);
    expect(database.getGmailConnection(connection.id)).toBeNull();
    expect(database.getArchive(archive.id)?.messageCount).toBe(2);
    expect(revoked).toBe(1);
  });

  it("a full sync ignores the incremental date filter and clears the connect-time query for future syncs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-full-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();

    const archive = database.createArchive({
      name: "Existing archive",
      sourceType: "mbox",
      fingerprint: "gmail-full-sync",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const folder = database.createFolder(archive.id, "Latest Gmail");
    const listQueries: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "https://www.googleapis.com/auth/gmail.readonly"
        });
      }
      if (url.pathname.endsWith("/users/me/profile")) {
        return jsonResponse({ emailAddress: "owner@example.test" });
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        listQueries.push(url.searchParams.get("q") ?? "");
        return jsonResponse({ messages: [], resultSizeEstimate: 0 });
      }
      if (url.pathname.endsWith("/users/me/labels")) {
        return jsonResponse({ labels: [] });
      }
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: "desktop-client-secret",
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    const authorization = gmail.startAuthorization({
      archiveId: archive.id,
      folderId: folder.id,
      archiveName: "Gmail",
      folderName: "Inbox",
      query: "newer_than:7d",
      ocrEnabled: false
    });
    const state = new URL(authorization.authorizationUrl).searchParams.get("state")!;
    const connection = await gmail.finishAuthorization(state, "authorization-code");
    await waitForSync(database, connection.id);
    expect(listQueries[0]).toBe("newer_than:7d in:anywhere");
    expect(database.getGmailConnection(connection.id)?.query).toBe("newer_than:7d");

    gmail.startSync(connection.id, { full: true });
    await waitForSync(database, connection.id);
    expect(listQueries[1]).toBe("in:anywhere");
    expect(database.getGmailConnection(connection.id)?.query).toBe("");

    gmail.startSync(connection.id);
    await waitForSync(database, connection.id);
    expect(listQueries[2]).toContain("in:anywhere");
    expect(listQueries[2]).not.toContain("newer_than");
  });

  it("mirrors Gmail labels into local folders, including custom labels and a catch-all", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-labels-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();

    const archive = database.createArchive({
      name: "Gmail",
      sourceType: "gmail",
      fingerprint: "gmail-label-mirroring",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const folder = database.createFolder(archive.id, "Work Gmail");
    const messages: Record<string, Buffer> = {
      "msg-inbox": simpleMessageFixture("Inbox message", "msg-inbox"),
      "msg-spam": simpleMessageFixture("Spam message", "msg-spam"),
      "msg-custom": simpleMessageFixture("Custom label message", "msg-custom"),
      "msg-none": simpleMessageFixture("Unmatched message", "msg-none")
    };
    const labelsByMessage: Record<string, string[]> = {
      "msg-inbox": ["INBOX"],
      "msg-spam": ["SPAM"],
      "msg-custom": ["Label_1"],
      "msg-none": ["CATEGORY_PERSONAL"]
    };
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "https://www.googleapis.com/auth/gmail.readonly"
        });
      }
      if (url.pathname.endsWith("/users/me/profile")) {
        return jsonResponse({ emailAddress: "labels@example.test" });
      }
      if (url.pathname.endsWith("/users/me/labels")) {
        return jsonResponse({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "SPAM", name: "SPAM", type: "system" },
            { id: "Label_1", name: "Work/Project", type: "user" }
          ]
        });
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        return jsonResponse({
          messages: Object.keys(messages).map((id) => ({ id })),
          resultSizeEstimate: Object.keys(messages).length
        });
      }
      for (const [id, raw] of Object.entries(messages)) {
        if (url.pathname.endsWith(`/users/me/messages/${id}`)) {
          return jsonResponse({ id, raw: raw.toString("base64url"), labelIds: labelsByMessage[id] });
        }
      }
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: null,
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    const connection = database.createGmailConnection({
      email: "labels@example.test",
      archiveId: archive.id,
      folderId: folder.id,
      query: "",
      ocrEnabled: false,
      canSend: false,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    gmail.startSync(connection.id);
    await waitForSync(database, connection.id);

    const folders = new Map(database.listFolders(archive.id).map((entry) => [entry.path, entry]));
    expect(folders.has("Work Gmail/Inbox")).toBe(true);
    expect(folders.has("Work Gmail/Spam")).toBe(true);
    expect(folders.has("Work Gmail/Work/Project")).toBe(true);
    expect(folders.has("Work Gmail/Archived")).toBe(true);
  });

  it("reorganizes messages imported before label mirroring existed, using each message's current Gmail labels", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-reorganize-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();

    const archive = database.createArchive({
      name: "Combined mail",
      sourceType: "mbox",
      fingerprint: "gmail-reorganize",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const rootFolder = database.ensureFolder(archive.id, "Gmail-Archive", "Gmail-Archive", null);
    const connection = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: archive.id,
      folderId: rootFolder.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: false,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });

    // Simulate three messages imported before label mirroring existed: all sitting flat
    // in the connection's own root folder, exactly like a pre-upgrade Gmail sync left them.
    const sentMessageId = insertLegacyGmailMessage(database, archive.id, rootFolder.id, "owner@example.test", "legacy-sent", "Sent last week");
    const spamMessageId = insertLegacyGmailMessage(database, archive.id, rootFolder.id, "owner@example.test", "legacy-spam", "Suspicious offer");
    const unmatchedMessageId = insertLegacyGmailMessage(database, archive.id, rootFolder.id, "owner@example.test", "legacy-other", "Old newsletter");

    const labelMembers: Record<string, string[]> = {
      TRASH: [],
      SPAM: ["legacy-spam"],
      DRAFT: [],
      SENT: ["legacy-sent"],
      INBOX: []
    };
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname.endsWith("/users/me/labels")) {
        return jsonResponse({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "SPAM", name: "SPAM", type: "system" },
            { id: "SENT", name: "SENT", type: "system" }
          ]
        });
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        const labelId = url.searchParams.get("labelIds")!;
        return jsonResponse({ messages: (labelMembers[labelId] ?? []).map((id) => ({ id })) });
      }
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: null,
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    gmail.reorganizeFolders(connection.id);
    await waitForReorganize(database, connection.id);

    const folders = new Map(database.listFolders(archive.id).map((entry) => [entry.path, entry.id]));
    expect(database.getMessage(sentMessageId)?.folderId).toBe(folders.get("Gmail-Archive/Sent"));
    expect(database.getMessage(spamMessageId)?.folderId).toBe(folders.get("Gmail-Archive/Spam"));
    expect(database.getMessage(unmatchedMessageId)?.folderId).toBe(folders.get("Gmail-Archive/Archived"));
    expect(database.getFolder(rootFolder.id)?.messageCount).toBe(0);
  });

  it("schedules Gmail sync on an interval and skips connections already syncing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-schedule-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();
    const archive = database.createArchive({
      name: "Gmail",
      sourceType: "gmail",
      fingerprint: "gmail-schedule",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const folder = database.createFolder(archive.id, "Inbox");
    const connection = database.createGmailConnection({
      email: "schedule@example.test",
      archiveId: archive.id,
      folderId: folder.id,
      query: "",
      ocrEnabled: false,
      canSend: false,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });

    let syncStarts = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        syncStarts += 1;
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname.endsWith("/users/me/labels")) return jsonResponse({ labels: [] });
      if (url.pathname.endsWith("/users/me/messages")) return jsonResponse({ messages: [], resultSizeEstimate: 0 });
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: null,
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    expect(syncStarts).toBe(0);
    gmail.configureSyncInterval(1 / 120); // fire almost immediately (500ms) for the test
    await waitForSync(database, connection.id);
    expect(syncStarts).toBeGreaterThanOrEqual(1);
    gmail.configureSyncInterval(0);
  });

  it("sends from a verified send-as alias and rejects an unverified one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-sendas-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();
    const archive = database.createArchive({
      name: "Gmail",
      sourceType: "gmail",
      fingerprint: "gmail-send-as",
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
      canSend: true,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });

    let sentFrom = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.pathname.endsWith("/users/me/settings/sendAs")) {
        return jsonResponse({
          sendAs: [
            { sendAsEmail: "owner@example.test", isPrimary: true, verificationStatus: "accepted" },
            { sendAsEmail: "alias@example.test", displayName: "Code", verificationStatus: "accepted" },
            { sendAsEmail: "unverified@example.test", verificationStatus: "pending" }
          ]
        });
      }
      if (url.pathname.endsWith("/users/me/messages/send")) {
        const request = JSON.parse(String(init?.body)) as { raw: string };
        const raw = Buffer.from(request.raw, "base64url");
        sentFrom = (await simpleParser(raw)).from?.value[0]?.address ?? "";
        return jsonResponse({ id: "gmail-sent-1", threadId: null });
      }
      if (url.pathname.endsWith("/users/me/messages/gmail-sent-1")) {
        return jsonResponse({ id: "gmail-sent-1", raw: Buffer.from("").toString("base64url"), labelIds: ["SENT"] });
      }
      throw new Error(`Unexpected Gmail test request: ${url}`);
    };
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: null,
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher
    });
    services.push({ gmail, imports, database });

    const aliases = await gmail.listSendAsAliases(connection.id);
    expect(aliases.map((alias) => alias.email)).toEqual([
      "owner@example.test",
      "alias@example.test"
    ]);

    await gmail.sendMessage(connection.id, {
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "From a custom domain",
      bodyText: "Sent from alias@example.test.",
      fromAddress: "alias@example.test"
    });
    expect(sentFrom).toBe("alias@example.test");

    await expect(gmail.sendMessage(connection.id, {
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "Blocked",
      bodyText: "This address is not verified.",
      fromAddress: "unverified@example.test"
    })).rejects.toBeInstanceOf(GmailPermissionError);
  });

  it("requires existing read-only authorizations to be granted send permission again", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-gmail-permission-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobStore = new BlobStore(dataDir);
    const imports = new ImportService(database, blobStore);
    await imports.initialize();
    const archive = database.createArchive({
      name: "Gmail",
      sourceType: "gmail",
      fingerprint: "gmail-read-only",
      sizeBytes: 0
    });
    database.completeArchive(archive.id, 0);
    const folder = database.createFolder(archive.id, "Inbox");
    const connection = database.createGmailConnection({
      email: "readonly@example.test",
      archiveId: archive.id,
      folderId: folder.id,
      query: "",
      ocrEnabled: false,
      canSend: false,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    const gmail = new GmailService(database, imports, {
      clientId: "desktop-client-id",
      clientSecret: null,
      redirectUri: () => "http://127.0.0.1:3001/api/gmail/oauth/callback",
      fetcher: async () => {
        throw new Error("Network must not be used without send permission");
      }
    });
    services.push({ gmail, imports, database });

    await expect(gmail.sendMessage(connection.id, {
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "Blocked",
      bodyText: "This should not be sent."
    })).rejects.toBeInstanceOf(GmailPermissionError);
  });
});

async function waitForSync(database: EmailDatabase, connectionId: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const connection = database.getGmailConnection(connectionId);
    if (connection && connection.status !== "syncing" && connection.lastSyncedAt) return connection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Gmail sync");
}

async function waitForReorganize(database: EmailDatabase, connectionId: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const connection = database.getGmailConnection(connectionId);
    if (connection && connection.status !== "syncing") return connection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Gmail folder reorganize");
}

function insertLegacyGmailMessage(
  database: EmailDatabase,
  archiveId: string,
  folderId: string,
  email: string,
  gmailMessageId: string,
  subject: string
): string {
  return database.insertMessage({
    archiveId,
    folderId,
    sourceKey: `gmail:${email}:${gmailMessageId}`,
    internetMessageId: null,
    subject,
    sender: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    bcc: [],
    sentAt: null,
    receivedAt: null,
    bodyText: subject,
    bodyHtml: null,
    headers: {},
    sizeBytes: 10,
    attachments: []
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function simpleMessageFixture(subject: string, messageId: string): Buffer {
  return Buffer.from([
    "From: Sender <sender@example.test>",
    "To: Owner <owner@example.test>",
    "Date: Sun, 13 Jul 2026 12:00:00 +0000",
    `Message-ID: <${messageId}@example.test>`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body for ${subject}.`,
    ""
  ].join("\r\n"), "utf8");
}

function gmailMessageFixture(): Buffer {
  const attachment = Buffer.from("Quarterly reconciliation workbook checklist", "utf8").toString("base64");
  return Buffer.from([
    "From: Finance <finance@example.test>",
    "To: Owner <owner@example.test>",
    "Date: Sun, 13 Jul 2026 12:00:00 +0000",
    "Message-ID: <gmail-message-1@example.test>",
    "Subject: Gmail attachment fixture",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=fixture-boundary",
    "",
    "--fixture-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This message came from Gmail.",
    "--fixture-boundary",
    "Content-Type: text/plain; name=gmail-notes.txt",
    "Content-Disposition: attachment; filename=gmail-notes.txt",
    "Content-Transfer-Encoding: base64",
    "",
    attachment,
    "--fixture-boundary--",
    ""
  ].join("\r\n"), "utf8");
}
