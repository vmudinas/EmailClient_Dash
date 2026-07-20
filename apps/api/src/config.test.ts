import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalPublicUrl = process.env.EMAIL_CLIENT_PUBLIC_URL;
const originalTrustProxy = process.env.EMAIL_CLIENT_TRUST_PROXY;
const originalAllowRemoteLogin = process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN;

afterEach(() => {
  if (originalPublicUrl === undefined) delete process.env.EMAIL_CLIENT_PUBLIC_URL;
  else process.env.EMAIL_CLIENT_PUBLIC_URL = originalPublicUrl;
  if (originalTrustProxy === undefined) delete process.env.EMAIL_CLIENT_TRUST_PROXY;
  else process.env.EMAIL_CLIENT_TRUST_PROXY = originalTrustProxy;
  if (originalAllowRemoteLogin === undefined) delete process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN;
  else process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN = originalAllowRemoteLogin;
});

describe("loadConfig", () => {
  it("normalizes the public origin used by server OAuth callbacks", () => {
    expect(loadConfig({ publicUrl: "https://mail.example.test/" }).publicUrl)
      .toBe("https://mail.example.test");
  });

  it("rejects a public URL containing a deployment subpath", () => {
    expect(() => loadConfig({ publicUrl: "https://mail.example.test/archive-mail" }))
      .toThrow("must be an origin");
  });

  it("keeps forwarded client addresses disabled unless explicitly trusted", () => {
    delete process.env.EMAIL_CLIENT_TRUST_PROXY;
    expect(loadConfig().trustProxy).toBe(false);
    process.env.EMAIL_CLIENT_TRUST_PROXY = "true";
    expect(loadConfig().trustProxy).toBe(true);
  });

  it("keeps remote login disabled unless explicitly enabled", () => {
    delete process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN;
    expect(loadConfig().allowRemoteLogin).toBe(false);
    process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN = "true";
    expect(loadConfig().allowRemoteLogin).toBe(true);
  });
});
