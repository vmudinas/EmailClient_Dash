#!/usr/bin/env node

const baseUrl = (process.env.ARCHIVE_MAIL_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const username = process.env.ARCHIVE_MAIL_SMOKE_USERNAME ?? "admin";
const pin = process.env.ARCHIVE_MAIL_SMOKE_PIN ?? "2332";
const requestTimeoutMs = Number(process.env.ARCHIVE_MAIL_SMOKE_TIMEOUT_MS ?? 10_000);
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const publicPrefixes = [
  "/api/health",
  "/api/auth/login",
  "/api/gmail/oauth/callback",
  "/api/auth/property-invitations",
  "/api/property-webhooks"
];

const swagger = await jsonRequest(`${baseUrl}/swagger/v1/swagger.json`);
const operations = Object.entries(swagger.paths).flatMap(([path, definition]) =>
  Object.entries(definition)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation }))
);

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, pin }),
  signal: AbortSignal.timeout(requestTimeoutMs)
});
if (!login.ok) throw new Error(`Smoke login failed with HTTP ${login.status}: ${await login.text()}`);
const { accessToken } = await login.json();
if (!accessToken) throw new Error("Smoke login did not return an access token");

const routeFailures = [];
for (const entry of operations) {
  if (isPublic(entry.path)) continue;
  const response = await invoke(entry, null, false);
  if (response.status !== 401) routeFailures.push({ ...entry, status: response.status, body: response.body });
}

const handlerResults = [];
const ordered = operations.toSorted((left, right) => operationPriority(left) - operationPriority(right));
for (const entry of ordered) {
  if (entry.path === "/api/auth/login") continue;
  if (entry.path === "/api/auth/logout") continue;
  if (entry.path === "/api/gmail/oauth/start") await configureSmokeGoogleClient(accessToken);
  handlerResults.push({ ...entry, ...await invoke(entry, accessToken, true) });
}

const authorizationFailures = await verifyRoleAuthorization(accessToken);

const configurationLimited = handlerResults.filter((result) =>
  result.status === 503
  && [
    "/api/messages/{messageId}/ai/analyze",
    "/api/messages/{messageId}/ai/draft-reply"
  ].includes(result.path)
  && result.body.includes("Configure and enable an AI provider")
);
const serverFailures = handlerResults.filter((result) =>
  result.status >= 500 && !configurationLimited.includes(result)
);
const statusCounts = handlerResults.reduce((counts, result) => {
  const family = `${Math.floor(result.status / 100)}xx`;
  counts[family] = (counts[family] ?? 0) + 1;
  return counts;
}, {});

console.log(`Swagger paths: ${Object.keys(swagger.paths).length}`);
console.log(`Swagger operations: ${operations.length}`);
console.log(`Protected route checks: ${operations.length - operations.filter((entry) => isPublic(entry.path)).length - routeFailures.length} passed`);
console.log(`Role and screen authorization checks: ${10 - authorizationFailures.length} passed`);
console.log(`Authenticated/public handler checks: ${handlerResults.length - serverFailures.length} passed`);
console.log(`Status families: ${Object.entries(statusCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
if (configurationLimited.length > 0)
  console.log(`Configuration-limited AI operations: ${configurationLimited.length} returned the expected 503`);

if (routeFailures.length > 0) {
  console.error("Routes that did not enforce authentication:");
  for (const failure of routeFailures) console.error(`  ${failure.method} ${failure.path}: ${failure.status} ${failure.body}`);
}
if (serverFailures.length > 0) {
  console.error("Operations returning server errors:");
  for (const failure of serverFailures) console.error(`  ${failure.method} ${failure.path}: ${failure.status} ${failure.body}`);
}
if (authorizationFailures.length > 0) {
  console.error("Role or screen authorization failures:");
  for (const failure of authorizationFailures) console.error(`  ${failure.label}: expected ${failure.expected}, received ${failure.actual}`);
}
if (routeFailures.length > 0 || authorizationFailures.length > 0 || serverFailures.length > 0) process.exitCode = 1;

async function verifyRoleAuthorization(adminToken) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdUsers = [];
  const failures = [];
  try {
    const limitedUser = await createSmokeUser(adminToken, {
      username: `smoke-user-${suffix}`,
      displayName: "Smoke Calendar User",
      role: "user",
      pin: "77331",
      allowedScreens: ["calendar"]
    });
    createdUsers.push(limitedUser.id);
    const userToken = await loginSmokeUser(limitedUser.username, "77331");
    await expectStatus(userToken, "GET", "/api/calendar/sources", 200, "calendar-enabled user can access Calendar", failures);
    await expectStatus(userToken, "GET", "/api/import-jobs", 403, "calendar-only user cannot access imports", failures);
    await expectStatus(userToken, "GET", "/api/ai/review-queue", 403, "calendar-only user cannot access AI", failures);
    await expectStatus(userToken, "GET", "/api/admin/reply-styles", 403, "calendar-only user cannot access Settings APIs", failures);
    await expectStatus(userToken, "GET", "/api/properties/overview", 403, "calendar-only user cannot access Properties", failures);

    const renter = await createSmokeUser(adminToken, {
      username: `smoke-renter-${suffix}`,
      displayName: "Smoke Renter",
      role: "renter",
      pin: "77332",
      allowedScreens: ["properties"]
    });
    createdUsers.push(renter.id);
    const renterToken = await loginSmokeUser(renter.username, "77332");
    await expectStatus(renterToken, "GET", "/api/properties/overview", 200, "renter can access property portal", failures);
    await expectStatus(renterToken, "GET", "/api/archives", 403, "renter cannot access mail archives", failures);
    await expectStatus(renterToken, "GET", "/api/calendar/sources", 403, "renter cannot access Calendar", failures);
    await expectStatus(renterToken, "GET", "/api/gmail/connections", 403, "renter cannot access Gmail", failures);
    await expectStatus(renterToken, "GET", "/api/admin/users", 403, "renter cannot access administration", failures);
  } finally {
    for (const userId of createdUsers) {
      await fetch(`${baseUrl}/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    }
  }
  return failures;
}

async function createSmokeUser(adminToken, body) {
  const response = await fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Could not create ${body.role} smoke user: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function loginSmokeUser(smokeUsername, smokePin) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: smokeUsername, pin: smokePin }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Could not log in ${smokeUsername}: HTTP ${response.status}`);
  return (await response.json()).accessToken;
}

async function expectStatus(token, method, path, expected, label, failures) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (response.status !== expected) failures.push({ label, expected, actual: response.status });
}

async function configureSmokeGoogleClient(token) {
  const response = await fetch(`${baseUrl}/api/admin/settings/gmail`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ clientId: "smoke-test.apps.googleusercontent.com" }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Could not configure the disposable Google OAuth client: HTTP ${response.status}`);
}

async function invoke(entry, token, exerciseHandler) {
  const url = new URL(resolvePath(entry.path), baseUrl);
  for (const parameter of entry.operation.parameters ?? []) {
    if (parameter.in !== "query" || !parameter.required) continue;
    url.searchParams.set(parameter.name, queryValue(parameter.name));
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method: entry.method, headers, signal: AbortSignal.timeout(requestTimeoutMs) };
  if (exerciseHandler && !["GET", "DELETE"].includes(entry.method)) {
    const request = requestBody(entry.path);
    headers["Content-Type"] = request.contentType;
    init.body = request.body;
  }
  try {
    const response = await fetch(url, init);
    return { status: response.status, body: (await response.text()).replace(/\s+/g, " ").slice(0, 300) };
  } catch (error) {
    return { status: 599, body: error instanceof Error ? error.message : String(error) };
  }
}

function resolvePath(path) {
  return path.replaceAll(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(pathValue(name)));
}

function pathValue(name) {
  if (name.toLowerCase().includes("date")) return "2026-07-22";
  return "00000000-0000-0000-0000-000000000001";
}

function queryValue(name) {
  if (name === "start") return "2026-07-22T00:00:00.000Z";
  if (name === "end") return "2026-07-23T00:00:00.000Z";
  if (name.toLowerCase().includes("date")) return "2026-07-22";
  if (name === "filename") return "smoke.txt";
  if (name === "q" || name === "query") return "smoke";
  return "smoke";
}

function requestBody(path) {
  if (path.includes("/chunk")) return { contentType: "application/octet-stream", body: new Uint8Array() };
  if (path.includes("/resumes")) return { contentType: "application/pdf", body: new Uint8Array() };
  if (path.endsWith("/photo")) return { contentType: "image/png", body: new Uint8Array() };
  if (path.includes("/attachments") || path.includes("/documents")) return { contentType: "application/octet-stream", body: new Uint8Array() };
  if (path === "/api/gmail/oauth/start") {
    return {
      contentType: "application/json",
      body: JSON.stringify({ archiveName: "Smoke Gmail", folderName: "Gmail", query: "newer_than:1d", ocrEnabled: false })
    };
  }
  return { contentType: "application/json", body: "{}" };
}

function operationPriority(entry) {
  if (entry.path === "/api/health") return -20;
  if (entry.path === "/api/gmail/oauth/start") return -10;
  if (entry.path === "/api/admin/settings/gmail" && entry.method === "DELETE") return 20;
  return entry.method === "GET" ? 0 : 10;
}

function isPublic(path) {
  return publicPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function jsonRequest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
