import { resolve } from "node:path";

process.env.EMAIL_CLIENT_WEB_DIR ??= resolve(import.meta.dirname, "apps/web/dist");

await import("./apps/api/dist/server.js");
