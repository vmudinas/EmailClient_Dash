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
    const rawMime = gmailMessageFixture();
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.toString().startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
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
      if (url.pathname.endsWith("/users/me/messages/send")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
        const request = JSON.parse(String(init?.body)) as { raw: string };
        sentRaw = Buffer.from(request.raw, "base64url");
        return jsonResponse({ id: "gmail-sent-1", threadId: "gmail-thread-1" });
      }
      if (url.pathname.endsWith("/users/me/messages/gmail-message-1")) {
        return jsonResponse({
          id: "gmail-message-1",
          raw: rawMime.toString("base64url"),
          labelIds: ["INBOX", "UNREAD"]
        });
      }
      if (url.pathname.endsWith("/users/me/messages/gmail-sent-1")) {
        return jsonResponse({
          id: "gmail-sent-1",
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
      "https://www.googleapis.com/auth/gmail.send"
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
      canSend: true
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
    expect(detail.folderPath).toBe("Latest Gmail");
    expect(detail.attachments).toHaveLength(1);
    const stored = database.getAttachmentBlob(detail.attachments[0]!.id)!;
    expect((await blobStore.read(stored.relativePath)).toString("utf8")).toContain("reconciliation workbook");

    const sent = await gmail.sendMessage(connection.id, {
      to: ["recipient@example.test"],
      cc: ["copy@example.test"],
      bcc: [],
      subject: "Sent from Archive Mail",
      bodyText: "This local client sent the message through Gmail."
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
    expect(database.getArchive(archive.id)).toMatchObject({ messageCount: 2, unreadCount: 1 });
    expect(database.search({ q: "local client sent" }).items[0]?.message.state.isRead).toBe(true);

    gmail.startSync(connection.id);
    const secondSync = await waitForSync(database, connection.id);
    expect(secondSync.importedItems).toBe(0);
    expect(database.getArchive(archive.id)?.messageCount).toBe(2);
    expect(listQueries).toHaveLength(2);
    expect(listQueries[0]).toBe("newer_than:7d");
    expect(listQueries[1]).toContain("after:");
    expect(database.listDiagnostics().map((event) => event.message)).toContain(
      "Email sent from owner@example.test"
    );

    await gmail.removeConnection(connection.id);
    expect(database.getGmailConnection(connection.id)).toBeNull();
    expect(database.getArchive(archive.id)?.messageCount).toBe(2);
    expect(revoked).toBe(1);
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
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
