import { describe, expect, it } from "vitest";
import { isPermanentError } from "../src/health";

// Covers conformance items around permanent-vs-retryable error
// classification (src/health.ts). These strings come from real AWS
// SSO-OIDC / Kiro error bodies; misclassifying them either spins the
// retry loop forever (permanent treated as transient) or surfaces a
// re-login error on a recoverable blip (transient treated as permanent).

describe("isPermanentError", () => {
  it("returns false for undefined / empty reason", () => {
    expect(isPermanentError(undefined)).toBe(false);
    expect(isPermanentError("")).toBe(false);
  });

  it.each([
    "Invalid refresh token",
    "Invalid grant provided",
    "InvalidGrantException",
    "UnauthorizedClientException",
    "AuthorizationPendingException",
    "ExpiredTokenException",
    "client is not registered",
    "The security token is expired",
    "Access denied",
  ])("classifies %j as permanent", (reason) => {
    expect(isPermanentError(reason)).toBe(true);
  });

  it("matches a permanent pattern embedded in a larger message", () => {
    expect(
      isPermanentError(
        'Refresh failed: {"__type":"InvalidGrantException","message":"..."}',
      ),
    ).toBe(true);
  });

  it("treats transient/network-style errors as non-permanent", () => {
    expect(isPermanentError("INSUFFICIENT_MODEL_CAPACITY")).toBe(false);
    expect(isPermanentError("429 Too Many Requests")).toBe(false);
    expect(isPermanentError("socket hang up")).toBe(false);
    expect(isPermanentError("ETIMEDOUT")).toBe(false);
  });

  it("is case-sensitive (matches the exact captured casing)", () => {
    // The patterns are matched verbatim; lower-cased variants must not
    // accidentally match, so we don't loosen the classifier by surprise.
    expect(isPermanentError("invalid refresh token")).toBe(false);
    expect(isPermanentError("Invalid refresh token")).toBe(true);
  });
});
