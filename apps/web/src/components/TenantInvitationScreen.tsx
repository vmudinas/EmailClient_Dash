import { useEffect, useState, type FormEvent } from "react";
import { Building2, CheckCircle2, LoaderCircle } from "lucide-react";
import type { AuthLoginResult, PropertyInvitationPreview } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

export function TenantInvitationScreen({
  api,
  token,
  onAccepted
}: {
  api: ApiClient;
  token: string;
  onAccepted: (result: AuthLoginResult) => void;
}) {
  const [invitation, setInvitation] = useState<PropertyInvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.previewPropertyInvitation(token).then((value) => {
      if (active) setInvitation(value);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Invitation could not be loaded");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, token]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim().toLowerCase();
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    if (password !== confirmation) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onAccepted(await api.acceptPropertyInvitation({ token, username, password }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invitation could not be accepted");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen tenant-invitation-screen">
      <form className="login-panel tenant-invitation-panel" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark"><Building2 size={23} /></span><div><strong>Tenant portal</strong><span>Secure property access</span></div></div>
        {loading ? <div className="property-loading"><LoaderCircle className="spin" size={22} /> Loading invitation…</div> : invitation ? (
          <>
            <div className="login-heading"><CheckCircle2 size={21} /><div><h1>Welcome, {invitation.tenantName}</h1><p>{invitation.organizationName} invited you to access leases, payments, documents, and service requests.</p></div></div>
            <label>Username<input name="username" autoComplete="username" required minLength={3} maxLength={64} /></label>
            <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
            <label>Confirm password<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
            <small>Use at least 12 characters with uppercase, lowercase, a number, and a symbol.</small>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="primary-button login-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <CheckCircle2 size={17} />} Create tenant account</button>
          </>
        ) : <p className="login-error" role="alert">{error || "Invitation is unavailable"}</p>}
      </form>
    </main>
  );
}
