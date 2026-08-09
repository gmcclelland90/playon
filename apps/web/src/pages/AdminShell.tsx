import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { can, roleAtLeast, type PublicUser } from "@playon/shared";
import { api } from "../api";
import { UpdateBanner } from "../components/UpdateBanner";

function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "operator":
      return "Operator";
    default:
      return role;
  }
}

export function AdminShell({ user }: { user: PublicUser }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/login", { replace: true });
    },
  });

  const showChat = can(user.role, "chat.agent");
  const showSettings = can(user.role, "settings.llm");
  const showSkills = roleAtLeast(user.role, "operator");
  const showFiles = roleAtLeast(user.role, "operator");
  const home = showChat ? "/" : "/dashboard";

  return (
    <div className="app-shell">
      <UpdateBanner user={user} />
      <header className="topbar">
        <div className="topbar-brand">
          <NavLink to={home} className="brand-mark">
            Play<span>On</span>
          </NavLink>
          <span className="role-chip" title="Signed-in role">
            {roleLabel(user.role)}
          </span>
        </div>
        <nav className="topbar-nav" aria-label="Admin">
          <div className="topbar-nav-primary">
            {showChat ? (
              <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : undefined)}>
                Map
              </NavLink>
            ) : null}
            <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : undefined)}>
              Dashboard
            </NavLink>
            {showSkills ? (
              <NavLink to="/skills" className={({ isActive }) => (isActive ? "active" : undefined)}>
                Skills
              </NavLink>
            ) : null}
            {showFiles ? (
              <NavLink to="/files" className={({ isActive }) => (isActive ? "active" : undefined)}>
                Files
              </NavLink>
            ) : null}
            {showSettings ? (
              <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : undefined)}>
                Settings
              </NavLink>
            ) : null}
          </div>
          <div className="topbar-nav-util">
            <NavLink to="/play" className="util">
              Player view
            </NavLink>
            <button
              type="button"
              className="linkish util"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              {logout.isPending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </nav>
        {logout.isError ? (
          <p className="error topbar-error" role="alert">
            {(logout.error as Error).message}
          </p>
        ) : null}
      </header>
      <main className={showChat ? "main-canvas" : "main-pages"}>
        <Outlet />
      </main>
    </div>
  );
}
