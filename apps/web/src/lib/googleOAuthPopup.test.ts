import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigateGoogleAuthorizationPopup,
  openGoogleAuthorizationPopup,
  showGoogleAuthorizationError
} from "./googleOAuthPopup.js";

describe("Google OAuth popup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows progress immediately and then navigates to Google", () => {
    const popup = popupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup.window);

    expect(openGoogleAuthorizationPopup()).toBe(popup.window);
    expect(popup.document.body.textContent).toContain("Preparing Google authorization");

    navigateGoogleAuthorizationPopup(popup.window, "https://accounts.google.com/o/oauth2/v2/auth?client_id=test");
    expect(popup.document.body.textContent).toContain("Continue to Google");
    expect(popup.replace).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=test");
  });

  it("keeps an actionable error in the opened tab when authorization cannot start", () => {
    const popup = popupWindow();
    showGoogleAuthorizationError(popup.window, "Gmail is not configured");
    expect(popup.document.body.textContent).toContain("Google authorization could not start");
    expect(popup.document.body.textContent).toContain("Gmail is not configured");
  });

  it("reports when the browser blocks the popup", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(openGoogleAuthorizationPopup()).toBeNull();
  });

  it("rejects a non-Google authorization destination", () => {
    const popup = popupWindow();
    expect(() => navigateGoogleAuthorizationPopup(popup.window, "https://example.test/oauth"))
      .toThrow("invalid Google authorization URL");
    expect(popup.replace).not.toHaveBeenCalled();
  });
});

function popupWindow() {
  const popupDocument = document.implementation.createHTMLDocument();
  const replace = vi.fn();
  const focus = vi.fn();
  return {
    document: popupDocument,
    replace,
    window: { document: popupDocument, location: { replace }, focus, closed: false } as unknown as Window
  };
}
