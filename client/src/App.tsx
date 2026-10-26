import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecordPage } from "./pages/RecordPage";
import { WalkthroughPage } from "./pages/WalkthroughPage";
import { TodayPage } from "./pages/TodayPage";
import { LoginPage } from "./pages/LoginPage";
import { api } from "./api/client";
import "./offline/sync"; // bootstraps the background sync loop

// Remembers that this phone has logged in before, so opening the app with no
// signal goes straight to your (saved) projects instead of a login screen it
// can't use. The real check is the server's session cookie, made whenever
// there's signal.
const SIGNED_IN_KEY = "punchlist.signedIn";
function rememberSignedIn(on: boolean) {
  try {
    if (on) localStorage.setItem(SIGNED_IN_KEY, "1");
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // storage blocked — offline open just won't skip the login screen
  }
}
function wasSignedIn() {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}

type AuthState = "checking" | "in" | "out" | "out-offline";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  useEffect(() => {
    api
      .me()
      .then((r) => {
        if (r.ok) {
          rememberSignedIn(true);
          setAuth("in");
        } else {
          rememberSignedIn(false);
          setAuth("out");
        }
      })
      .catch(() => setAuth(wasSignedIn() ? "in" : "out-offline"));

    const onSignedOut = () => {
      rememberSignedIn(false);
      setAuth("out");
    };
    window.addEventListener("pl-signed-out", onSignedOut);
    return () => window.removeEventListener("pl-signed-out", onSignedOut);
  }, []);

  if (auth === "checking") {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  if (auth === "out" || auth === "out-offline") {
    return (
      <LoginPage
        offlineFirstTime={auth === "out-offline"}
        onSignedIn={() => {
          rememberSignedIn(true);
          setAuth("in");
        }}
      />
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProjectsPage
            onLogout={async () => {
              await api.logout().catch(() => {});
              rememberSignedIn(false);
              setAuth("out");
            }}
          />
        }
      />
      <Route path="/projects/:projectId/record" element={<RecordPage />} />
      <Route path="/walkthroughs/:id" element={<WalkthroughPage />} />
      <Route path="/today" element={<TodayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
