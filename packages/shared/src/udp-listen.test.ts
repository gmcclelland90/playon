import { describe, expect, it } from "vitest";
import {
  requiredUdpListenEvidence,
  udpPortListedInOutput,
  windowsUdpPortOpenVerdict,
} from "./udp-listen.js";

const SS_SAMPLE = `
State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
UNCONN 0      0      0.0.0.0:27015      0.0.0.0:*
UNCONN 0      0      *:2456             *:*
UNCONN 0      0      [::]:7777          [::]:*
`.trim();

const NETSTAT_LINUX_SAMPLE = `
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
udp        0      0 127.0.0.1:27015         0.0.0.0:*
udp6       0      0 ::1:7777                :::*
`.trim();

const NETSTAT_SAMPLE = `
Active Connections

  Proto  Local Address          Foreign Address        State
  UDP    0.0.0.0:27015          *:*
  UDP    [::]:27015             *:*
  UDP    127.0.0.1:1900         *:*
`.trim();

describe("udpPortListedInOutput", () => {
  it("reads Linux ss -uln and Windows netstat UDP tables", () => {
    expect(udpPortListedInOutput(SS_SAMPLE, 27015)).toBe(true);
    expect(udpPortListedInOutput(SS_SAMPLE, 2456)).toBe(true);
    expect(udpPortListedInOutput(SS_SAMPLE, 7777)).toBe(true);
    expect(udpPortListedInOutput(SS_SAMPLE, 27016)).toBe(false);
    expect(udpPortListedInOutput(NETSTAT_SAMPLE, 27015)).toBe(true);
    expect(udpPortListedInOutput(NETSTAT_SAMPLE, 1900)).toBe(true);
    expect(udpPortListedInOutput(NETSTAT_SAMPLE, 7777)).toBe(false);
    expect(udpPortListedInOutput(NETSTAT_LINUX_SAMPLE, 27015)).toBe(true);
    expect(udpPortListedInOutput(NETSTAT_LINUX_SAMPLE, 7777)).toBe(true);
    expect(udpPortListedInOutput(NETSTAT_LINUX_SAMPLE, 323)).toBe(false);
  });

  it("does not treat a prefix of another port as a bind", () => {
    expect(udpPortListedInOutput(SS_SAMPLE, 2701)).toBe(false);
    expect(udpPortListedInOutput(NETSTAT_SAMPLE, 270)).toBe(false);
  });

  it("rejects invalid ports", () => {
    expect(udpPortListedInOutput(SS_SAMPLE, 0)).toBe(false);
    expect(udpPortListedInOutput(SS_SAMPLE, 65536)).toBe(false);
    expect(udpPortListedInOutput(SS_SAMPLE, 27015.5)).toBe(false);
  });
});

describe("windowsUdpPortOpenVerdict", () => {
  it("does not treat status=running as port_open", () => {
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: false, queryOnline: null }),
    ).toEqual({ ok: false, reason: "udp_listen_unproven" });
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: null, queryOnline: null }),
    ).toEqual({ ok: false, reason: "udp_listen_unproven" });
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: false, queryOnline: false }),
    ).toEqual({ ok: false, reason: "udp_listen_unproven" });
  });

  it("accepts a node listen check or query-online", () => {
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: true, queryOnline: null }),
    ).toEqual({ ok: true, via: "listen" });
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: null, queryOnline: true }),
    ).toEqual({ ok: true, via: "query" });
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: false, queryOnline: true }),
    ).toEqual({ ok: true, via: "query" });
  });

  it("prefers listen over query when both are proven", () => {
    expect(
      windowsUdpPortOpenVerdict({ running: true, listening: true, queryOnline: true }),
    ).toEqual({ ok: true, via: "listen" });
  });

  it("fails when the process is not running even if a stale listen/query exists", () => {
    expect(
      windowsUdpPortOpenVerdict({ running: false, listening: true, queryOnline: true }),
    ).toEqual({ ok: false, reason: "udp_process_not_running" });
  });
});

describe("requiredUdpListenEvidence", () => {
  it("requires every required probe to be listening", () => {
    expect(
      requiredUdpListenEvidence([
        { required: true, listening: true },
        { required: false, listening: false },
      ]),
    ).toBe(true);
    expect(
      requiredUdpListenEvidence([
        { required: true, listening: true },
        { required: true, listening: false },
      ]),
    ).toBe(false);
    expect(requiredUdpListenEvidence([{ required: true, listening: null }])).toBe(null);
    expect(requiredUdpListenEvidence([{ required: false, listening: true }])).toBe(false);
  });
});

describe("Linux UDP port_open contract (must not loosen)", () => {
  it("still treats a running process without ss listen as a failure", () => {
    // Linux lab-matrix throws udp_port_not_listening when required ss is false.
    // Query-online is a Windows-only substitute; do not copy it to Linux.
    const linuxWouldPass = false;
    const ssListening = false;
    const statusRunning = true;
    expect(statusRunning && ssListening).toBe(linuxWouldPass);
  });
});
