import { describe, expect, it } from "vitest";
import {
  buildContainerCreateOptions,
  formatDockerBind,
  resolveContainerIsolation,
  resolveContainerTty,
  windowsContainerPath,
} from "./docker-create-options.js";
import type { ContainerSpec } from "./types.js";

const linuxSpec: ContainerSpec = {
  name: "playon-a",
  image: "itzg/minecraft-server:latest",
  env: { EULA: "TRUE" },
  cmd: ["--lan"],
  ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
  binds: [{ hostPath: "/srv/playon/a/game", containerPath: "/data" }],
};

describe("windowsContainerPath", () => {
  it("rewrites Unix data mounts to a Windows drive path", () => {
    expect(windowsContainerPath("/data")).toBe("C:\\data");
    expect(windowsContainerPath("/server/game")).toBe("C:\\server\\game");
  });

  it("normalizes already-Windows destinations", () => {
    expect(windowsContainerPath("C:\\data")).toBe("C:\\data");
    expect(windowsContainerPath("C:/sbox")).toBe("C:\\sbox");
  });

  it("leaves skip sentinels alone", () => {
    expect(windowsContainerPath("none")).toBe("none");
    expect(windowsContainerPath("-")).toBe("-");
  });
});

describe("formatDockerBind", () => {
  it("keeps Linux binds unchanged", () => {
    expect(formatDockerBind("/srv/a/game", "/data", "linux")).toBe("/srv/a/game:/data");
  });

  it("uses Windows destinations on a Windows engine", () => {
    expect(formatDockerBind("C:\\playon\\servers\\a\\game", "/data", "windows")).toBe(
      "C:\\playon\\servers\\a\\game:C:\\data",
    );
  });
});

describe("resolveContainerTty / isolation", () => {
  it("defaults TTY on for Windows engines (docker run -t)", () => {
    expect(resolveContainerTty({}, "windows")).toBe(true);
    expect(resolveContainerTty({}, "linux")).toBe(false);
    expect(resolveContainerTty({ tty: true }, "linux")).toBe(true);
    expect(resolveContainerTty({ tty: false }, "windows")).toBe(false);
  });

  it("uses skill isolation, else the Windows daemon default", () => {
    expect(resolveContainerIsolation({}, { osType: "linux" })).toBeUndefined();
    expect(
      resolveContainerIsolation({}, { osType: "windows", isolation: "process" }),
    ).toBe("process");
    expect(
      resolveContainerIsolation({ isolation: "hyperv" }, { osType: "windows", isolation: "process" }),
    ).toBe("hyperv");
  });
});

describe("buildContainerCreateOptions", () => {
  it("keeps the Linux create shape (Tty false, Unix binds, no Isolation)", () => {
    const opts = buildContainerCreateOptions(linuxSpec, { osType: "linux" });
    expect(opts.Tty).toBe(false);
    expect(opts.OpenStdin).toBe(true);
    expect(opts.Cmd).toEqual(["--lan"]);
    expect(opts.HostConfig?.Binds).toEqual(["/srv/playon/a/game:/data"]);
    expect(opts.HostConfig?.Isolation).toBeUndefined();
    expect(opts.ExposedPorts).toEqual({ "25565/tcp": {} });
  });

  it("applies Windows isolation, TTY, and bind destinations", () => {
    const spec: ContainerSpec = {
      name: "playon-sbox",
      image: "har0x/sbox-server:latest",
      cmd: ["+game", "facepunch.sandbox", "+hostname", "PlayOn"],
      binds: [{ hostPath: "C:\\playon-node\\data\\servers\\s1\\game", containerPath: "/data" }],
      ports: [{ host: 27015, container: 27015, protocol: "udp" }],
    };
    const opts = buildContainerCreateOptions(spec, { osType: "windows", isolation: "process" });
    expect(opts.Tty).toBe(true);
    expect(opts.Cmd).toEqual(["+game", "facepunch.sandbox", "+hostname", "PlayOn"]);
    expect(opts.HostConfig?.Isolation).toBe("process");
    expect(opts.HostConfig?.Binds).toEqual([
      "C:\\playon-node\\data\\servers\\s1\\game:C:\\data",
    ]);
    expect(opts.ExposedPorts).toEqual({ "27015/udp": {} });
  });
});
