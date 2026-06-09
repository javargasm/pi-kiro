// Permanent error classification for Kiro API and OAuth responses.
//
// Some errors (expired grants, revoked tokens) are permanent — retrying
// them wastes time and confuses users with spinning indicators.

const PERMANENT_PATTERNS = [
  "Invalid refresh token",
  "Invalid grant provided",
  "InvalidGrantException",
  "UnauthorizedClientException",
  "AuthorizationPendingException",
  "ExpiredTokenException",
  "client is not registered",
  "The security token is expired",
  "Access denied",
];

/**
 * Returns true if the error message indicates a permanent failure that
 * will not resolve without user re-authentication.
 */
export function isPermanentError(reason?: string): boolean {
  if (!reason) return false;
  return PERMANENT_PATTERNS.some((p) => reason.includes(p));
}
