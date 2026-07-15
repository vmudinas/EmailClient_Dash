import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmailDatabase } from "../storage/database.js";
import { AuthConflictError, AuthService } from "./auth-service.js";

const databases: EmailDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AuthService", () => {
  it("hashes the default PIN and creates IP-bound revocable sessions", async () => {
    const { auth, database } = await createService();
    const admin = database.getUserRecordByUsername("admin")!;
    expect(admin.pinHash).not.toContain("2332");
    expect(admin.pinSalt.length).toBeGreaterThan(10);

    const login = auth.login({
      username: "admin",
      pin: "2332",
      ipAddress: "127.0.0.1",
      userAgent: "test"
    });
    expect(login.session).toMatchObject({ role: "admin", user: { username: "admin" } });
    expect(auth.authenticate(login.accessToken, "127.0.0.1")?.user.username).toBe("admin");
    expect(auth.authenticate(login.accessToken, "192.168.1.20")).toBeNull();

    auth.logout(login.session.id);
    expect(auth.authenticate(login.accessToken, "127.0.0.1")).toBeNull();
  });

  it("attributes named users and prevents removal of the last administrator", async () => {
    const { auth, database } = await createService();
    const admin = database.getUserRecordByUsername("admin")!;
    expect(() => auth.updateUser(admin.id, { role: "user" })).toThrow(AuthConflictError);
    expect(() => auth.updateUser(admin.id, { isActive: false })).toThrow(AuthConflictError);

    const second = auth.createUser({
      username: "jordan",
      displayName: "Jordan Lee",
      role: "admin",
      pin: "8822"
    });
    const updated = auth.updateUser(admin.id, { role: "user" });
    expect(updated.role).toBe("user");
    expect(database.countActiveAdmins()).toBe(1);

    const login = auth.login({
      username: second.username,
      pin: "8822",
      ipAddress: "10.0.0.7",
      userAgent: null,
      roleCap: "viewer"
    });
    expect(login.session.role).toBe("viewer");
  });
});

async function createService(): Promise<{ auth: AuthService; database: EmailDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-auth-"));
  directories.push(directory);
  const database = new EmailDatabase(directory);
  databases.push(database);
  const auth = new AuthService(database, 60);
  auth.initialize();
  return { auth, database };
}
