import { describe, expect, it } from "vitest";
import {
  LoginTotpSchema,
  MfaEnrollConfirmSchema,
  MfaHostFileResetSchema,
  MfaStatusSchema,
  PASSWORD_RESET_FILE_NAME,
  PasswordResetCompleteSchema,
  PasswordResetStartResponseSchema,
  PasswordResetStartSchema,
} from "./api.js";

describe("password reset request contract", () => {
  it("requires a username to start and never describes a code field", () => {
    expect(PasswordResetStartSchema.parse({ username: "host" }).username).toBe("host");
    expect(PasswordResetStartSchema.safeParse({}).success).toBe(false);
    expect(PasswordResetStartSchema.safeParse({ username: "host", code: "nope" }).success).toBe(
      true,
    );
    expect("code" in PasswordResetStartSchema.parse({ username: "host", code: "nope" })).toBe(
      false,
    );
  });

  it("requires username, a single proof, and an 8+ character password to complete", () => {
    expect(
      PasswordResetCompleteSchema.parse({
        username: "host",
        code: "ABCD-EFGH-IJKL-MNOP",
        password: "password123",
      }).password,
    ).toBe("password123");
    expect(
      PasswordResetCompleteSchema.safeParse({
        username: "host",
        totpCode: "123456",
        password: "password123",
      }).success,
    ).toBe(true);
    expect(
      PasswordResetCompleteSchema.safeParse({
        username: "host",
        code: "ABCD",
        password: "short",
      }).success,
    ).toBe(false);
    expect(
      PasswordResetCompleteSchema.safeParse({
        username: "host",
        password: "password123",
      }).success,
    ).toBe(false);
  });

  it("keeps the start response free of the host code", () => {
    expect(PASSWORD_RESET_FILE_NAME).toBe("password-reset.txt");
    expect(
      PasswordResetStartResponseSchema.parse({
        ok: true,
        methods: ["host_file"],
        fileName: PASSWORD_RESET_FILE_NAME,
        expiresAt: "2026-08-25T00:15:00.000Z",
      }).dataRoot,
    ).toBeUndefined();
    expect(
      PasswordResetStartResponseSchema.parse({
        ok: true,
        methods: ["totp"],
      }).fileName,
    ).toBeUndefined();
    expect(
      "code" in
        PasswordResetStartResponseSchema.parse({
          ok: true,
          methods: ["host_file"],
          fileName: PASSWORD_RESET_FILE_NAME,
          expiresAt: "2026-08-25T00:15:00.000Z",
          code: "secret",
        }),
    ).toBe(false);
  });
});

describe("authenticator MFA request contract", () => {
  it("requires an mfaToken and a code to finish a pending login", () => {
    expect(LoginTotpSchema.parse({ mfaToken: "pending", code: "123456" }).code).toBe("123456");
    expect(LoginTotpSchema.safeParse({ mfaToken: "pending" }).success).toBe(false);
    expect(LoginTotpSchema.safeParse({ code: "123456" }).success).toBe(false);
  });

  it("describes enroll confirm, host-file toggle, and status without secrets", () => {
    expect(MfaEnrollConfirmSchema.parse({ code: "123456", disableHostFileReset: true }).code).toBe(
      "123456",
    );
    expect(MfaHostFileResetSchema.parse({ enabled: false, code: "123456" }).enabled).toBe(false);
    expect(MfaStatusSchema.parse({ totpEnabled: true, hostFileResetEnabled: false })).toEqual({
      totpEnabled: true,
      hostFileResetEnabled: false,
    });
    expect("secret" in MfaStatusSchema.parse({ totpEnabled: true, hostFileResetEnabled: true, secret: "x" })).toBe(
      false,
    );
  });
});
