import { useState } from "react";
import { api, type SessionUser } from "../api/client";

// Same username and password as Homebuilder Ops.
export function LoginPage({
  onSignedIn,
  offlineFirstTime,
}: {
  onSignedIn: (u: SessionUser) => void;
  offlineFirstTime?: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(username.trim(), password));
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "No connection — logging in needs signal. Once you're logged in, the app works offline."
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Punch List</h1>
      </header>
      <form className="card" onSubmit={submit}>
        <h2>Log in</h2>
        <p className="muted">Use your Homebuilder Ops username and password.</p>
        {offlineFirstTime && (
          <p className="error">
            No connection. Log in once with signal — after that the app opens and records
            offline.
          </p>
        )}
        <input
          placeholder="Username"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          placeholder="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
