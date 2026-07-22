import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTrackingClient,
  deriveTrackingToken,
  hashTrackingToken,
  isAuthenticTrackingToken,
  isValidTrackingToken,
  normalizeHttpsDestination,
  normalizePublicBaseUrl,
  parseCreateEmailTrackingInput,
} from "./emailTracking.js";

test("hashTrackingToken returns a stable SHA-256 digest", () => {
  const token = "A".repeat(43);
  assert.equal(hashTrackingToken(token), hashTrackingToken(token));
  assert.match(hashTrackingToken(token), /^[a-f0-9]{64}$/);
});

test("tracking tokens must be 32-byte base64url strings", () => {
  assert.equal(isValidTrackingToken("A".repeat(43)), true);
  assert.equal(isValidTrackingToken("A".repeat(42)), false);
  assert.equal(isValidTrackingToken(`${"A".repeat(42)}+`), false);
});

test("tracking tokens are deterministic per campaign idempotency key", () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 86_400;
  const token = deriveTrackingToken(
    "x".repeat(32),
    "test_campaign",
    "opaque_key_123456",
    expiresAtSeconds,
  );
  assert.equal(token.length, 43);
  assert.equal(
    token,
    deriveTrackingToken(
      "x".repeat(32),
      "test_campaign",
      "opaque_key_123456",
      expiresAtSeconds,
    ),
  );
  assert.equal(isAuthenticTrackingToken(token, "x".repeat(32)), true);
  assert.equal(isAuthenticTrackingToken(token, "y".repeat(32)), false);
});

test("click destinations require credential-free https URLs", () => {
  assert.equal(
    normalizeHttpsDestination("https://ceed.cloud/contact"),
    "https://ceed.cloud/contact",
  );
  assert.throws(() => normalizeHttpsDestination("http://ceed.cloud"));
  assert.throws(() => normalizeHttpsDestination("https://user:pass@ceed.cloud"));
  assert.throws(() => normalizeHttpsDestination("https://example.com"));
  assert.throws(() =>
    normalizeHttpsDestination(
      "https://ceed.cloud/?utm_campaign=person@example.com",
    ),
  );
});

test("public base URL must be an HTTPS origin", () => {
  assert.equal(
    normalizePublicBaseUrl("https://tracker.example.com/"),
    "https://tracker.example.com",
  );
  assert.throws(() =>
    normalizePublicBaseUrl("https://tracker.example.com/base"),
  );
  assert.throws(() =>
    normalizePublicBaseUrl("https://tracker.example.com/?token=value"),
  );
});

test("registration input contains no caller-supplied recipient identifier", () => {
  assert.deepEqual(
    parseCreateEmailTrackingInput({
      campaignId: "test_campaign",
      idempotencyKey: "opaque_key_123456",
      recipientId: "person@example.com",
      destinationUrl: "https://ceed.cloud/",
      sentAt: "2026-07-22T12:00:00Z",
    }),
    {
      campaignId: "test_campaign",
      idempotencyKey: "opaque_key_123456",
      destinationUrl: "https://ceed.cloud/",
      sentAt: "2026-07-22T12:00:00Z",
    },
  );
});

test("sentAt requires a real UTC ISO date-time", () => {
  const base = {
    campaignId: "test_campaign",
    idempotencyKey: "opaque_key_123456",
    destinationUrl: "https://ceed.cloud/",
  };
  assert.throws(() =>
    parseCreateEmailTrackingInput({ ...base, sentAt: "2026-07-22" }),
  );
  assert.throws(() =>
    parseCreateEmailTrackingInput({
      ...base,
      sentAt: "2026-02-30T12:00:00Z",
    }),
  );
  assert.equal(
    parseCreateEmailTrackingInput({
      ...base,
      sentAt: "2026-07-22T12:00:00Z",
    }).sentAt,
    "2026-07-22T12:00:00Z",
  );
});

test("campaign metadata accepts opaque variants only", () => {
  assert.throws(() =>
    parseCreateEmailTrackingInput({
      campaignId: "test_campaign",
      idempotencyKey: "opaque_key_123456",
      destinationUrl: "https://ceed.cloud/",
      subjectVariant: "person@example.com",
      sentAt: "2026-07-22T12:00:00Z",
    }),
  );
});

test("known proxy and scanner user agents are classified", () => {
  assert.deepEqual(classifyTrackingClient("GoogleImageProxy"), {
    category: "google_image_proxy",
    isLikelyAutomated: false,
  });
  assert.deepEqual(classifyTrackingClient("Proofpoint URL Scanner"), {
    category: "automated_scanner",
    isLikelyAutomated: true,
  });
  assert.deepEqual(
    classifyTrackingClient("Microsoft Outlook Proofpoint URL Scanner"),
    {
      category: "automated_scanner",
      isLikelyAutomated: true,
    },
  );
  assert.deepEqual(classifyTrackingClient("Mozilla/5.0"), {
    category: "unknown",
    isLikelyAutomated: false,
  });
});
