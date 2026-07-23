export function openGoogleAuthorizationPopup(): Window | null {
  const popup = window.open("", "_blank");
  if (!popup) return null;
  renderPopup(
    popup,
    "Preparing Google authorization",
    "Archive Mail is creating a secure Google sign-in request. This page will continue automatically."
  );
  popup.focus();
  return popup;
}

export function navigateGoogleAuthorizationPopup(popup: Window, value: string): void {
  const authorizationUrl = new URL(value);
  if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com") {
    throw new Error("The server returned an invalid Google authorization URL");
  }

  renderPopup(
    popup,
    "Continue to Google",
    "If Google does not open automatically, use the button below.",
    authorizationUrl.toString()
  );
  popup.focus();
  popup.location.replace(authorizationUrl.toString());
}

export function showGoogleAuthorizationError(popup: Window, message: string): void {
  renderPopup(
    popup,
    "Google authorization could not start",
    message,
    undefined,
    "Return to Archive Mail, correct the Google OAuth configuration in Admin settings, and try again."
  );
}

function renderPopup(
  popup: Window,
  title: string,
  message: string,
  continueUrl?: string,
  guidance?: string
): void {
  const document = popup.document;
  document.title = title;
  document.head.replaceChildren();
  document.body.replaceChildren();

  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width, initial-scale=1";
  const style = document.createElement("style");
  style.textContent = "body{margin:0;background:#f4f6fa;color:#182230;font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:560px;margin:12vh auto;padding:32px;border:1px solid #d8dee9;border-radius:14px;background:#fff;box-shadow:0 18px 50px #1f29371f}h1{margin:0 0 12px;font-size:24px}p{margin:10px 0;color:#526071}a{display:inline-block;margin-top:14px;padding:10px 16px;border-radius:8px;background:#1a73e8;color:#fff;font-weight:700;text-decoration:none}";
  document.head.append(meta, style);

  const main = document.createElement("main");
  const heading = document.createElement("h1");
  heading.textContent = title;
  const detail = document.createElement("p");
  detail.textContent = message;
  main.append(heading, detail);
  if (continueUrl) {
    const link = document.createElement("a");
    link.href = continueUrl;
    link.textContent = "Continue to Google";
    main.append(link);
  }
  if (guidance) {
    const help = document.createElement("p");
    help.textContent = guidance;
    main.append(help);
  }
  document.body.append(main);
}
