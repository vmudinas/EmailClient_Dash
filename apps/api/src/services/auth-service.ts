import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type {
  AuthLoginResult,
  AuthSessionInfo,
  SessionRole,
  UserCreate,
  UserSummary,
  UserUpdate
} from "@email-client/shared";
import type {
  AuthSessionRecord,
  EmailStore,
  UserRecord
} from "../storage/database.js";

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PIN = "2332";
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BLOCK_MS = 30_000;
const TOUCH_INTERVAL_MS = 60_000;

interface FailedLoginState {
  failures: number;
  blockedUntil: number;
}

export interface LoginInput {
  username: string;
  pin: string;
  ipAddress: string;
  userAgent: string | null;
  roleCap?: "viewer";
  expiresAtCap?: Date | null;
}

export class AuthError extends Error {}
export class AuthRateLimitError extends AuthError {}
export class AuthConflictError extends AuthError {}

export class AuthService {
  private readonly failedLogins = new Map<string, FailedLoginState>();
  private readonly lastTouches = new Map<string, number>();

  constructor(
    private readonly database: EmailStore,
    readonly sessionLifetimeMinutes: number
  ) {}

  initialize(): void {
    this.database.purgeExpiredSessions();
    this.database.revokeAllSessions();
    if (this.database.listUsers().length > 0) return;
    const hashed = hashPin(DEFAULT_ADMIN_PIN);
    this.database.createUser({
      username: DEFAULT_ADMIN_USERNAME,
      displayName: "Administrator",
      role: "admin",
      pinHash: hashed.hash,
      pinSalt: hashed.salt,
      mustChangePin: true
    });
  }

  login(input: LoginInput): AuthLoginResult {
    this.assertLoginAllowed(input.ipAddress);
    const user = this.database.getUserRecordByUsername(input.username);
    if (!user?.isActive || !verifyPin(input.pin, user)) {
      this.recordLoginFailure(input.ipAddress);
      throw new AuthError("Invalid username or PIN");
    }

    this.failedLogins.delete(input.ipAddress);
    const accessToken = randomBytes(32).toString("base64url");
    const role: SessionRole = input.roleCap ?? user.role;
    const normalExpiry = Date.now() + this.sessionLifetimeMinutes * 60_000;
    const expiry = input.expiresAtCap
      ? Math.min(normalExpiry, input.expiresAtCap.getTime())
      : normalExpiry;
    const session = this.database.createAuthSession({
      userId: user.id,
      role,
      tokenHash: tokenHash(accessToken),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt: new Date(expiry).toISOString()
    });
    this.database.markUserLogin(user.id);
    return {
      accessToken,
      session: this.toSessionInfo({
        ...session,
        user: this.database.getUser(user.id)!
      })
    };
  }

  authenticate(accessToken: string | null, ipAddress: string): AuthSessionRecord | null {
    if (!accessToken) return null;
    const session = this.database.getAuthSessionByTokenHash(tokenHash(accessToken));
    if (!session || session.ipAddress !== ipAddress) return null;
    const now = Date.now();
    const lastTouch = this.lastTouches.get(session.id) ?? 0;
    if (now - lastTouch >= TOUCH_INTERVAL_MS) {
      this.lastTouches.set(session.id, now);
      this.database.touchAuthSession(session.id);
    }
    return session;
  }

  sessionInfo(accessToken: string | null, ipAddress: string): AuthSessionInfo | null {
    const session = this.authenticate(accessToken, ipAddress);
    return session ? this.toSessionInfo(session) : null;
  }

  logout(sessionId: string): void {
    this.lastTouches.delete(sessionId);
    this.database.revokeAuthSession(sessionId);
  }

  listUsers(): UserSummary[] {
    return this.database.listUsers();
  }

  createUser(input: UserCreate): UserSummary {
    if (this.database.getUserRecordByUsername(input.username)) {
      throw new AuthConflictError("That username already exists");
    }
    const hashed = hashPin(input.pin);
    return this.database.createUser({
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      pinHash: hashed.hash,
      pinSalt: hashed.salt,
      mustChangePin: false
    });
  }

  updateUser(id: string, update: UserUpdate): UserSummary {
    const current = this.database.getUserRecord(id);
    if (!current) throw new AuthError("User not found");
    const removesLastAdmin = current.role === "admin"
      && current.isActive
      && (update.role === "user" || update.isActive === false)
      && this.database.countActiveAdmins() <= 1;
    if (removesLastAdmin) {
      throw new AuthConflictError("At least one active administrator is required");
    }

    const hashed = update.pin ? hashPin(update.pin) : null;
    const user = this.database.updateUser(id, {
      displayName: update.displayName,
      role: update.role,
      isActive: update.isActive,
      pinHash: hashed?.hash,
      pinSalt: hashed?.salt,
      mustChangePin: hashed ? false : undefined
    });
    this.database.revokeUserSessions(id);
    return user;
  }

  changePin(session: AuthSessionRecord, currentPin: string, newPin: string): void {
    const user = this.database.getUserRecord(session.user.id);
    if (!user || !verifyPin(currentPin, user)) throw new AuthError("Current PIN is incorrect");
    const hashed = hashPin(newPin);
    this.database.updateUser(user.id, {
      pinHash: hashed.hash,
      pinSalt: hashed.salt,
      mustChangePin: false
    });
    this.database.revokeUserSessions(user.id);
  }

  hasDefaultPinWarning(): boolean {
    return this.database.listUsers().some((user) => (
      user.role === "admin" && user.isActive && user.mustChangePin
    ));
  }

  toSessionInfo(session: AuthSessionRecord): AuthSessionInfo {
    return {
      id: session.id,
      user: session.user,
      role: session.role,
      expiresAt: session.expiresAt
    };
  }

  private assertLoginAllowed(ipAddress: string): void {
    const state = this.failedLogins.get(ipAddress);
    if (!state || state.blockedUntil <= Date.now()) return;
    const seconds = Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 1_000));
    throw new AuthRateLimitError(`Too many failed attempts. Try again in ${seconds} seconds.`);
  }

  private recordLoginFailure(ipAddress: string): void {
    const current = this.failedLogins.get(ipAddress) ?? { failures: 0, blockedUntil: 0 };
    current.failures += 1;
    if (current.failures >= LOGIN_FAILURE_LIMIT) {
      current.failures = 0;
      current.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    }
    this.failedLogins.set(ipAddress, current);
  }
}

function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("base64url");
  return {
    salt,
    hash: scryptSync(pin, salt, 64).toString("base64url")
  };
}

function verifyPin(pin: string, user: UserRecord): boolean {
  const expected = Buffer.from(user.pinHash, "base64url");
  const actual = scryptSync(pin, user.pinSalt, expected.byteLength);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function tokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}
