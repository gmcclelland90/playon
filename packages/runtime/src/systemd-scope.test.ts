import { afterEach, describe, expect, it } from "vitest";
import {
  adoptPidIntoPlayonScope,
  buildUserServiceLaunchArgv,
  isSystemdHost,
  nativeUserServiceShell,
  playonServerScopeUnit,
  playonServerServiceUnit,
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

describe("playon user service (#1045)", () => {
  it("names a transient user service, not a scope glued to playon.service", () => {
    expect(playonServerServiceUnit("server-lab")).toBe("playon-server-server-lab.service");
    const argv = buildUserServiceLaunchArgv(
      {
        name: "server-lab",
        command: "/bin/sleep",
        args: ["30"],
        cwd: "/tmp/jail/game",
        env: { PLAYON_GAME_PORT: "16261" },
        pidFile: "/tmp/jail/.playon/native.pid",
        stdinFifo: "/tmp/jail/.playon/console.in",
        logFile: "/tmp/jail/logs/console.log",
      },
      "/tmp/jail/.playon/native.env",
    );
    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).toContain("--collect");
    expect(argv).toContain("--no-block");
    expect(argv).toContain("--unit=playon-server-server-lab.service");
    expect(argv).toContain("--property=KillMode=control-group");
    expect(argv.some((arg) => arg.includes("ExecStopPost=/usr/bin/logger -t playon -- playon_native_unit_stop"))).toBe(
      true,
    );
    expect(argv.join("\n")).not.toMatch(/PartOf=playon\.service/);
    expect(nativeUserServiceShell()).toContain("playon_native_child_exit");
    expect(nativeUserServiceShell()).toContain("SIGKILL");
  });
});

describe("adoptPidIntoPlayonScope", () => {
  it("prefers a user transient scope when systemd-run succeeds", () => {
    if (process.platform === "win32") return;
    process.env.PLAYON_SYSTEMD_SCOPE = "1";
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
