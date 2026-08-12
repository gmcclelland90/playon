import { afterEach, describe, expect, it } from "vitest";
import { buildCorsOrigins, isProductionEnv, loadConfig, splitSkillsRootPaths } from "./config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("loadConfig production guards", () => {
  it("allows dev without session secret", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cfg-"));
    temps.push(root);
    const cfg = loadConfig({
      PLAYON_DATA_ROOT: root,
      PLAYON_ENV: "development",
    });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.sessionSecret).toMatch(/^dev-/);
  });

  it("refuses production without PLAYON_SESSION_SECRET", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cfg-"));
    temps.push(root);
    expect(() =>
      loadConfig({
        PLAYON_DATA_ROOT: root,
        PLAYON_ENV: "production",
        PLAYON_ADVERTISE_HOST: "192.168.1.10",
      }),
    ).toThrow(/PLAYON_SESSION_SECRET/);
  });

  it("refuses production without PLAYON_ADVERTISE_HOST", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cfg-"));
    temps.push(root);
    expect(() =>
      loadConfig({
        PLAYON_DATA_ROOT: root,
        NODE_ENV: "production",
        PLAYON_SESSION_SECRET: "super-secret-value",
      }),
    ).toThrow(/PLAYON_ADVERTISE_HOST/);
  });

  it("loads production when secret and advertise host are set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cfg-"));
    temps.push(root);
    const cfg = loadConfig({
      PLAYON_DATA_ROOT: root,
      PLAYON_ENV: "production",
      PLAYON_SESSION_SECRET: "super-secret-value",
      PLAYON_ADVERTISE_HOST: "192.168.1.50",
      PLAYON_HOST: "0.0.0.0",
      PLAYON_CORS_ORIGINS: "http://custom.local:3000",
    });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.advertiseHost).toBe("192.168.1.50");
    expect(cfg.sessionSecret).toBe("super-secret-value");
    expect(cfg.corsOrigins).toContain("http://192.168.1.50:8787");
    expect(cfg.corsOrigins).toContain("http://custom.local:3000");
  });
});

describe("buildCorsOrigins", () => {
  it("includes vite localhost, playon.local, and advertise host variants", () => {
    const origins = buildCorsOrigins({ advertiseHost: "10.0.0.2", port: 8787 });
    expect(origins).toContain("http://localhost:5173");
    expect(origins).toContain("http://10.0.0.2");
    expect(origins).toContain("http://10.0.0.2:8787");
    expect(origins).toContain("http://playon.local");
    expect(origins).toContain("http://playon.local:8787");
  });

  it("includes Discord-linked public hostname", () => {
    const origins = buildCorsOrigins({
      advertiseHost: "10.0.0.2",
      port: 8787,
      publicHostname: "alice.playon.games",
    });
    expect(origins).toContain("https://alice.playon.games");
  });
});

describe("isProductionEnv", () => {
  it("detects PLAYON_ENV and NODE_ENV", () => {
    expect(isProductionEnv({ PLAYON_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({})).toBe(false);
  });
});

describe("splitSkillsRootPaths", () => {
  it("keeps Windows drive letters intact", () => {
    if (process.platform !== "win32") return;
    expect(splitSkillsRootPaths("D:\\data\\skills;E:\\more")).toEqual([
      "D:\\data\\skills",
      "E:\\more",
    ]);
  });
});

describe("PLAYON_SKILLS_ROOT", () => {
  it("loads baked platform skills and skips fixtures when minimal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cfg-"));
    temps.push(root);
    const skills = path.join(root, "skills");
    fs.mkdirSync(path.join(skills, "platform"), { recursive: true });
    fs.mkdirSync(path.join(skills, "fixtures"), { recursive: true });
    const data = path.join(root, "data");
    const cfg = loadConfig({
      PLAYON_DATA_ROOT: data,
      PLAYON_SKILLS_ROOT: skills,
      PLAYON_SKILLS_PROFILE: "minimal",
    });
    expect(cfg.skillsRoots.some((p) => p.replace(/\\/g, "/").endsWith("/platform"))).toBe(
      true,
    );
    expect(cfg.skillsRoots.some((p) => p.replace(/\\/g, "/").endsWith("/fixtures"))).toBe(
      false,
    );
  });
});
