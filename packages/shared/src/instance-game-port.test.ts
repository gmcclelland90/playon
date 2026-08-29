import { describe, expect, it } from "vitest";
import {
  instanceGamePortFromIniText,
  instanceGamePortFromIniTexts,
  parseIniIntKey,
  parseInstanceIniPorts,
} from "./instance-game-port.js";

const HUB_INI = [
  "DefaultPort=16271",
  "UDPPort=16272",
  "PublicName=Hub",
  "",
].join("\n");

const FRONTIER_INI = [
  "# extra PZ instance",
  "DefaultPort = 16265",
  "UDPPort = 16266",
  "",
].join("\n");

describe("parseInstanceIniPorts", () => {
  it("reads PZ Hub.ini DefaultPort / UDPPort", () => {
    expect(parseInstanceIniPorts(HUB_INI)).toEqual({ defaultPort: 16271, udpPort: 16272 });
    expect(instanceGamePortFromIniText(HUB_INI)).toBe(16271);
  });

  it("accepts spaces around = and trailing comments", () => {
    expect(parseInstanceIniPorts(FRONTIER_INI)).toEqual({
      defaultPort: 16265,
      udpPort: 16266,
    });
    expect(parseIniIntKey("UDPPort=16266 ; raknet\n", "UDPPort")).toBe(16266);
  });

  it("prefers DefaultPort over UDPPort for the advertised game port", () => {
    expect(instanceGamePortFromIniText("UDPPort=16272\nDefaultPort=16271\n")).toBe(16271);
  });

  it("falls back to UDPPort when DefaultPort is missing", () => {
    expect(instanceGamePortFromIniText("UDPPort=16272\n")).toBe(16272);
  });

  it("rejects out-of-range and absent keys", () => {
    expect(instanceGamePortFromIniText("DefaultPort=0\n")).toBeNull();
    expect(instanceGamePortFromIniText("DefaultPort=70000\n")).toBeNull();
    expect(instanceGamePortFromIniText("PublicName=NZL\n")).toBeNull();
  });

  it("does not treat skill-default 16261 as implied when the instance has another port", () => {
    expect(instanceGamePortFromIniTexts([HUB_INI, "DefaultPort=16261\n"])).toBe(16271);
    expect(instanceGamePortFromIniTexts(["PublicName=empty\n", FRONTIER_INI])).toBe(16265);
  });
});
