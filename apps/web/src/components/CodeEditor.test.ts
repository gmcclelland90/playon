import { describe, expect, it } from "vitest";
import { languageFromPath } from "./CodeEditor";

describe("languageFromPath", () => {
  it("maps common skill and config extensions", () => {
    expect(languageFromPath("metadata.yaml")).toBe("yaml");
    expect(languageFromPath("guides/INSTALL.md")).toBe("markdown");
    expect(languageFromPath("game/server.properties")).toBe("ini");
    expect(languageFromPath("query/connector.mjs")).toBe("javascript");
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("unknown.bin")).toBe("plaintext");
  });
});
