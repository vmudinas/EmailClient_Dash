import { useState, type FormEvent } from "react";
import { Archive, KeyRound, LoaderCircle, LogIn } from "lucide-react";

interface LoginScreenProps {
  busy: boolean;
  error: string;
  pairedViewer: boolean;
  onLogin(username: string, pin: string): void;
}

export function LoginScreen({ busy, error, pairedViewer, onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState("admin");
  const [pin, setPin] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onLogin(username.trim().toLowerCase(), pin);
  };

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark"><Archive size={23} /></span>
          <div><strong>Archive Mail</strong><span>{pairedViewer ? "Paired read-only viewer" : "Local email archive"}</span></div>
        </div>
        <div className="login-heading">
          <KeyRound size={21} />
          <div><h1>Sign in</h1><p>Enter your Archive Mail username and PIN.</p></div>
        </div>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            disabled={busy}
          />
        </label>
        <label>
          PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4,12}"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))}
            autoComplete="current-password"
            disabled={busy}
          />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary-button login-submit" disabled={busy || username.trim().length < 3 || pin.length < 4}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}
          Sign in
        </button>
        <small>First-run account: <code>admin</code> with PIN <code>2332</code>.</small>
      </form>
    </main>
  );
}
