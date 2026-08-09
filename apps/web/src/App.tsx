import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { can, roleAtLeast } from "@playon/shared";
import { api } from "./api";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminShell } from "./pages/AdminShell";
import { PlayerPage } from "./pages/PlayerPage";
import { CanvasPage } from "./pages/CanvasPage";
import { DashboardPage } from "./pages/DashboardPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { FilesPage } from "./pages/FilesPage";

export function App() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    enabled: setup.data?.needsSetup === false,
  });

  if (setup.isLoading) {
    return (
      <div className="auth-screen" aria-busy="true">
        <div className="auth-panel auth-loading">
          <h1 className="brand-mark">
            Play<span>On</span>
          </h1>
          <div className="skeleton" aria-hidden>
            <div className="skeleton-row compact" />
            <div className="skeleton-row" />
          </div>
          <p className="muted status-inline">Loading…</p>
        </div>
      </div>
    );
  }

  if (setup.data?.needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  }

  // Don't bounce deep links to /login while the session probe is in flight.
  if (me.isPending) {
    return (
      <div className="auth-screen" aria-busy="true">
        <div className="auth-panel auth-loading">
          <h1 className="brand-mark">
            Play<span>On</span>
          </h1>
          <div className="skeleton" aria-hidden>
            <div className="skeleton-row compact" />
            <div className="skeleton-row" />
          </div>
          <p className="muted status-inline">Loading…</p>
        </div>
      </div>
    );
  }

  const user = me.data?.user;
  const authed = Boolean(user);
  const showChat = user ? can(user.role, "chat.agent") : false;
  const showSettings = user ? can(user.role, "settings.llm") : false;
  const showSkills = user ? roleAtLeast(user.role, "operator") : false;
  const showFiles = user ? roleAtLeast(user.role, "operator") : false;
  const home = showChat ? "/" : "/dashboard";

  return (
    <Routes>
      <Route path="/play" element={<PlayerPage />} />
      <Route path="/login" element={authed ? <Navigate to={home} replace /> : <LoginPage />} />
      {authed && user ? (
        <Route element={<AdminShell user={user} />}>
          {showChat ? (
            <Route index element={<CanvasPage user={user} />} />
          ) : (
            <Route index element={<Navigate to="dashboard" replace />} />
          )}
          <Route path="dashboard" element={<DashboardPage user={user} />} />
          {showSkills ? <Route path="skills" element={<SkillsPage user={user} />} /> : null}
          {showFiles ? <Route path="files" element={<FilesPage user={user} />} /> : null}
          {showSettings ? <Route path="settings" element={<SettingsPage user={user} />} /> : null}
          <Route path="servers/*" element={<Navigate to={home} replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
    </Routes>
  );
}
