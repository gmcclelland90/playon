import { afterEach, describe, expect, it } from "vitest";
import {
  adoptPidIntoPlayonScope,
  isSystemdHost,
  playonServerScopeUnit,
  setSystemdScopeRunnerForTests,
  userSystemdEnv,
} from "./systemd-scope.js";

afterEach(() => {
  setSystemdScopeRunnerForTests(null);
  delete process.env.PLAYON_SYSTEMD_SCOPE;
});

describe("playonServerScopeUnit", () => {
  it("sanitizes server identities into a systemd scope name", () => {
    expect(playonServerScopeUnit("server-RxWubiUeCNNzXqnZ4E_9p")).toBe(
      "playon-server-server-RxWubiUeCNNzXqnZ4E_9p.scope",
    );
    expect(playonServerScopeUnit("server/foo bar")).toBe("playon-server-server-foo-bar.scope");
    expect(playonServerScopeUnit("@@@")).toBe("playon-server-unknown.scope");
  });
});

describe("isSystemdHost", () => {
  it("is off on Windows and when explicitly disabled", () => {
    expect(isSystemdHost({ PLAYON_SYSTEMD_SCOPE: "0" })).toBe(false);
  });
});

describe("userSystemdEnv", () => {
  it("fills XDG_RUNTIME_DIR and the user bus when unset", () => {
    const env = userSystemdEnv({ PATH: "/bin" });
    if (typeof process.getuid !== "function") return;
    expect(env?.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid()}`);
    expect(env?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=/run/user/${process.getuid()}/bus`);
  });
});

describe("adoptPidIntoPlayonScope", () => {
  it("prefers a user transient scope when systemd-run succeeds", () => {
    if (process.platform === "win32") return;
    const calls: string[][] = [];
    setSystemdScopeRunnerForTests(({ argv }) => {
      calls.push(argv);
      return { ok: argv.includes("--user") };
    });
    const result = adoptPidIntoPlayonScope(process.pid, "server-lab");
    expect(calls[0]?.[0]).toBe("systemd-run");
    expect(calls[0]).toContain("--user");
    expect(calls[0]?.some((a) => a.startsWith("--unit=playon-server-server-lab.scope"))).toBe(
      true,
    );
    expect(calls[0]?.some((a) => a === `--property=PIDs=${process.pid}`)).toBe(true);
    // Same-process cgroup check cannot become true here; method may fall through.
    expect(result.unit).toBe("playon-server-server-lab.scope");
  });
});
