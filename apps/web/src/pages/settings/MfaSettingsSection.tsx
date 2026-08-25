import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { TotpQr } from "../../components/TotpQr";

export function MfaSettingsSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["mfa"], queryFn: api.mfaStatus });
  const [view, setView] = useState<"idle" | "enroll" | "disable" | "host-file">("idle");
  const [code, setCode] = useState("");
  const [disableHostFile, setDisableHostFile] = useState(false);
  const [enroll, setEnroll] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostFileEnabled, setHostFileEnabled] = useState(true);

  const startEnroll = useMutation({
    mutationFn: api.startMfaEnroll,
    onSuccess: (result) => {
      setEnroll(result);
      setView("enroll");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmEnroll = useMutation({
    mutationFn: () =>
      api.confirmMfaEnroll({ code, disableHostFileReset: disableHostFile }),
    onSuccess: (result) => {
      setBackupCodes(result.backupCodes);
      setEnroll(null);
      setCode("");
      setView("idle");
      void qc.invalidateQueries({ queryKey: ["mfa"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const disable = useMutation({
    mutationFn: () => api.disableMfa({ code }),
    onSuccess: () => {
      setCode("");
      setView("idle");
      void qc.invalidateQueries({ queryKey: ["mfa"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const setHostFile = useMutation({
    mutationFn: () => api.setHostFileReset({ enabled: hostFileEnabled, code }),
    onSuccess: () => {
      setCode("");
      setView("idle");
      void qc.invalidateQueries({ queryKey: ["mfa"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const totpOn = Boolean(status.data?.totpEnabled);
  const hostFileOn = status.data?.hostFileResetEnabled !== false;

  return (
    <section className="stack tight">
      <p className="section-label">Authenticator</p>
      <p className="muted status-inline">
        {totpOn
          ? "Authenticator is on. Sign-in asks for a 6-digit app code (or a backup code)."
          : "Optional TOTP app. If you skip this, password reset stays the host-file challenge."}
      </p>
      {backupCodes ? (
        <div className="stack tight">
          <p className="ok">Save these backup codes. They are shown once.</p>
          <ul className="backup-codes">
            {backupCodes.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view === "enroll" && enroll ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            confirmEnroll.mutate();
          }}
        >
          <TotpQr value={enroll.otpauthUrl} />
          <p className="field-hint">
            Manual secret: <code className="totp-secret">{enroll.secret}</code>
          </p>
          <label className="field">
            <span>Authenticator code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
            />
          </label>
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={disableHostFile}
              onChange={(e) => setDisableHostFile(e.target.checked)}
            />
            <span>Turn off host-file recovery</span>
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={confirmEnroll.isPending}>
              {confirmEnroll.isPending ? "Checking…" : "Confirm"}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                void api.cancelMfaEnroll();
                setView("idle");
                setEnroll(null);
                setCode("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {view === "disable" ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <label className="field">
            <span>Authenticator code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={disable.isPending}>
              Turn off authenticator
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setView("idle")}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {view === "host-file" ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            setHostFile.mutate();
          }}
        >
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={hostFileEnabled}
              onChange={(e) => setHostFileEnabled(e.target.checked)}
            />
            <span>Allow host-file password reset</span>
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={setHostFile.isPending}>
              Save
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setView("idle")}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {view === "idle" ? (
        <div className="btn-row">
          {totpOn ? (
            <>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setHostFileEnabled(hostFileOn);
                  setView("host-file");
                  setError(null);
                }}
              >
                {hostFileOn ? "Host-file reset is on" : "Host-file reset is off"}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setView("disable");
                  setCode("");
                  setError(null);
                }}
              >
                Turn off authenticator
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={startEnroll.isPending}
              onClick={() => startEnroll.mutate()}
            >
              {startEnroll.isPending ? "Starting…" : "Set up authenticator"}
            </button>
          )}
        </div>
      ) : null}
      {error && view === "idle" ? <p className="error">{error}</p> : null}
    </section>
  );
}
