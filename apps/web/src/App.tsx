import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminShell } from "./pages/AdminShell";
import { PlayerPage } from "./pages/PlayerPage";

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
      <div className="auth-screen">
        <p className="muted">Loading PlayOn…</p>
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

  const authed = Boolean(me.data?.user);

  return (
    <Routes>
      <Route path="/play" element={<PlayerPage />} />
      <Route path="/login" element={authed ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/*"
        element={authed ? <AdminShell user={me.data!.user} /> : <Navigate to="/login" replace />}
      />
    </Routes>
  );
}
