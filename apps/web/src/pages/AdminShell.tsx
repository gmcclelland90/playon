import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { can, type PublicUser } from "@playon/shared";
import { api } from "../api";
import { ChatPage } from "./ChatPage";
import { DashboardPage } from "./DashboardPage";
import { ServersPage } from "./ServersPage";
import { SettingsPage } from "./SettingsPage";

export function AdminShell({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const showChat = can(user.role, "chat.agent");
  const showSettings = can(user.role, "settings.llm");
  const home = showChat ? "/" : "/dashboard";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <h1 className="brand-mark">
            Play<span>On</span>
          </h1>
          <span className="role-chip" title="Signed-in role">
            {user.role}
          </span>
        </div>
        <nav className="topbar-nav" aria-label="Admin">
          {showChat ? (
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : undefined)}>
              Chat
            </NavLink>
          ) : null}
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : undefined)}>
            Dashboard
          </NavLink>
          <NavLink to="/servers" className={({ isActive }) => (isActive ? "active" : undefined)}>
            Servers
          </NavLink>
          {showSettings ? (
            <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : undefined)}>
              Settings
            </NavLink>
          ) : null}
          <NavLink to="/play" className="util">
            Player view
          </NavLink>
          <button type="button" className="linkish util" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </nav>
      </header>
      <main>
        <Routes>
          {showChat ? <Route path="/" element={<ChatPage user={user} />} /> : null}
          <Route path="/dashboard" element={<DashboardPage user={user} />} />
          <Route path="/servers" element={<ServersPage user={user} />} />
          {showSettings ? (
            <Route path="/settings" element={<SettingsPage user={user} />} />
          ) : null}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}
