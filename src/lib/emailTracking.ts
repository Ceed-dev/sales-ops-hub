import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";

import type {
  CreateEmailTrackingRecipientInput,
  EmailTrackingClientCategory,
  EmailTrackingEventDoc,
  EmailTrackingEventType,
  EmailTrackingRecipientDoc,
} from "../types/emailTracking.js";

const RECIPIENTS_COLLECTION = "emailTrackingRecipients";
const REGISTRATIONS_COLLECTION = "emailTrackingRegistrations";
const EVENTS_COLLECTION = "emailTrackingEvents";
const CAMPAIGN_SUMMARY_SHARDS_COLLECTION =
  "emailTrackingCampaignSummaryShards";
const SUMMARY_SHARD_COUNT = 20;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ALLOWED_DESTINATION_HOSTS = new Set([
  "ceed.cloud",
  "www.ceed.cloud",
  "lp.ceed.cloud",
  "calendly.com",
]);
const EVENT_RETENTION_DAYS = 90;
const RECIPIENT_RETENTION_DAYS = 365;
const MISSING_RECIPIENT_CACHE_TTL_MS = 60_000;
const MAX_RECENT_ATTEMPTS = 10_000;
const recentEventAttempts = new Map<
  string,
  { expiresAt: number; recipient: EmailTrackingRecipientDoc | null }
>();
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function campaignSummaryShardId(campaignId: string, seed: string): string {
  const shard =
    createHash("sha256").update(seed).digest().readUInt32BE(0) %
    SUMMARY_SHARD_COUNT;
  return `${campaignId}_${String(shard).padStart(2, "0")}`;
}

export function hashTrackingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isValidTrackingToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function normalizeHttpsDestination(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !ALLOWED_DESTINATION_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("destinationUrl must use an approved Ceed destination");
  }
  const allowedQueryKeys = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
  ]);
  for (const [key, queryValue] of url.searchParams.entries()) {
    if (
      !allowedQueryKeys.has(key) ||
      queryValue.length > 100 ||
      queryValue.includes("@")
    ) {
      throw new Error("destinationUrl contains an unsupported query parameter");
    }
  }
  return url.toString();
}

export function deriveTrackingToken(
  signingSecret: string,
  campaignId: string,
  idempotencyKey: string,
  expiresAtSeconds: number,
): string {
  const identifier = createHmac("sha256", signingSecret)
    .update(`id:\0${campaignId}:\0${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  const expiry = Buffer.allocUnsafe(4);
  expiry.writeUInt32BE(expiresAtSeconds);
  const signature = createHmac("sha256", signingSecret)
    .update(Buffer.concat([identifier, expiry]))
    .digest()
    .subarray(0, 12);
  return Buffer.concat([identifier, expiry, signature]).toString("base64url");
}

export function isAuthenticTrackingToken(
  token: string,
  signingSecret: string,
): boolean {
  if (!isValidTrackingToken(token) || Buffer.byteLength(signingSecret) < 32) {
    return false;
  }
  const decoded = Buffer.from(token, "base64url");
  const identifier = decoded.subarray(0, 16);
  const expiry = decoded.subarray(16, 20);
  const receivedSignature = decoded.subarray(20);
  if (expiry.readUInt32BE() <= Math.floor(Date.now() / 1000)) return false;
  const expectedSignature = createHmac("sha256", signingSecret)
    .update(Buffer.concat([identifier, expiry]))
    .digest()
    .subarray(0, 12);
  return timingSafeEqual(receivedSignature, expectedSignature);
}

export function classifyTrackingClient(
  userAgent: string,
): { category: EmailTrackingClientCategory; isLikelyAutomated: boolean } {
  const normalized = userAgent.toLowerCase();

  if (
    normalized.includes("bot") ||
    normalized.includes("crawler") ||
    normalized.includes("scanner") ||
    normalized.includes("safelinks") ||
    normalized.includes("proofpoint") ||
    normalized.includes("mimecast")
  ) {
    return { category: "automated_scanner", isLikelyAutomated: true };
  }
  if (normalized.includes("googleimageproxy")) {
    return { category: "google_image_proxy", isLikelyAutomated: false };
  }
  if (
    normalized.includes("microsoft office") ||
    normalized.includes("outlook")
  ) {
    return { category: "outlook_proxy", isLikelyAutomated: false };
  }
  return { category: "unknown", isLikelyAutomated: false };
}

function isAuthorized(req: Request): boolean {
  const expected = (process.env.EMAIL_TRACKING_ADMIN_TOKEN || "").trim();
  const received = (req.get("x-email-tracking-admin-token") || "").trim();
  if (!expected || !received) return false;

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function requireAdmin(req: Request): "ok" | "unconfigured" | "forbidden" {
  const configuredToken = (
    process.env.EMAIL_TRACKING_ADMIN_TOKEN || ""
  ).trim();
  if (Buffer.byteLength(configuredToken, "utf8") < 32) {
    return "unconfigured";
  }
  return isAuthorized(req) ? "ok" : "forbidden";
}

function optionalText(
  value: unknown,
  field: string,
  maxLength = 100,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${field} must be a string up to ${maxLength} characters`);
  }
  return value.trim();
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  const parsed = optionalText(value, field);
  if (parsed && !IDENTIFIER_PATTERN.test(parsed)) {
    throw new Error(`${field} must be an opaque identifier`);
  }
  return parsed;
}

export function parseCreateEmailTrackingInput(
  body: unknown,
): CreateEmailTrackingRecipientInput {
  if (!body || typeof body !== "object") {
    throw new Error("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const campaignId = optionalText(input.campaignId, "campaignId");
  const idempotencyKey = optionalText(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const destinationUrl = optionalText(
    input.destinationUrl,
    "destinationUrl",
    2048,
  );

  if (!campaignId || !IDENTIFIER_PATTERN.test(campaignId)) {
    throw new Error("campaignId must use letters, numbers, dot, dash or underscore");
  }
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error("idempotencyKey must be an opaque identifier");
  }
  if (!destinationUrl) throw new Error("destinationUrl is required");

  const sentAt = optionalText(input.sentAt, "sentAt");
  if (!sentAt || !UTC_DATE_TIME_PATTERN.test(sentAt)) {
    throw new Error("sentAt must be an ISO UTC date-time");
  }
  const parsed = new Date(sentAt);
  const normalizedInput = sentAt.replace(/\.000Z$/, "Z");
  const normalizedParsed = parsed.toISOString().replace(/\.000Z$/, "Z");
  if (normalizedParsed !== normalizedInput) {
    throw new Error("sentAt must be a valid ISO UTC date-time");
  }
  const industry = optionalIdentifier(input.industry, "industry");
  const subjectVariant = optionalIdentifier(
    input.subjectVariant,
    "subjectVariant",
  );
  const bodyVariant = optionalIdentifier(input.bodyVariant, "bodyVariant");

  return {
    campaignId,
    idempotencyKey,
    destinationUrl: normalizeHttpsDestination(destinationUrl),
    ...(industry ? { industry } : {}),
    ...(subjectVariant ? { subjectVariant } : {}),
    ...(bodyVariant ? { bodyVariant } : {}),
    sentAt,
  };
}

export function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_BASE_URL must be an https origin");
  }
  return url.origin;
}

function publicBaseUrl(): string {
  return normalizePublicBaseUrl((process.env.PUBLIC_BASE_URL || "").trim());
}

function trackingSigningSecrets(): string[] {
  const value = (process.env.EMAIL_TRACKING_SIGNING_SECRET || "").trim();
  let values: unknown = [value];
  if (value.startsWith("[")) {
    values = JSON.parse(value);
  }
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 3 ||
    values.some(
      (secret) =>
        typeof secret !== "string" ||
        Buffer.byteLength(secret.trim(), "utf8") < 32,
    )
  ) {
    throw new Error("EMAIL_TRACKING_SIGNING_SECRET is not configured");
  }
  return values.map((secret) => (secret as string).trim());
}

async function recordEvent(
  db: Firestore,
  tokenHash: string,
  eventType: EmailTrackingEventType,
  userAgent: string,
  requireFreshRecipient = false,
): Promise<EmailTrackingRecipientDoc | null> {
  const recipientRef = db.collection(RECIPIENTS_COLLECTION).doc(tokenHash);
  const now = Timestamp.now();
  const client = classifyTrackingClient(userAgent);
  const eventDay = now.toDate().toISOString().slice(0, 10).replace(/-/g, "");
  const attemptKey = `${tokenHash}:${eventType}:${client.category}`;
  const lastAttempt = recentEventAttempts.get(attemptKey);
  if (
    lastAttempt &&
    Date.now() < lastAttempt.expiresAt
  ) {
    if (requireFreshRecipient) {
      const snapshot = await recipientRef.get();
      if (!snapshot.exists) return null;
      const freshRecipient = snapshot.data() as EmailTrackingRecipientDoc;
      return freshRecipient.expiresAt.toMillis() > Date.now()
        ? freshRecipient
        : null;
    }
    const cachedRecipient = lastAttempt.recipient;
    if (
      cachedRecipient &&
      cachedRecipient.expiresAt.toMillis() > Date.now()
    ) {
      return cachedRecipient;
    }
    recentEventAttempts.delete(attemptKey);
  }
  if (recentEventAttempts.size >= MAX_RECENT_ATTEMPTS) {
    const oldestKey = recentEventAttempts.keys().next().value as
      | string
      | undefined;
    if (oldestKey) recentEventAttempts.delete(oldestKey);
  }
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(`${tokenHash}_${eventType}_${eventDay}_${client.category}`);

  const result = await db.runTransaction(async (transaction) => {
    const recipientSnapshot = await transaction.get(recipientRef);
    if (!recipientSnapshot.exists) return null;
    const eventSnapshot = await transaction.get(eventRef);

    const recipient = recipientSnapshot.data() as EmailTrackingRecipientDoc;
    if (recipient.expiresAt.toMillis() <= now.toMillis()) return null;
    if (eventSnapshot.exists) return recipient;
    const countField = eventType === "open" ? "openCount" : "clickCount";
    const scannerCountField =
      eventType === "open" ? "scannerOpenCount" : "scannerClickCount";
    const firstTimestamp =
      eventType === "open" ? recipient.firstOpenedAt : recipient.firstClickedAt;
    const lastTimestamp =
      eventType === "open" ? recipient.lastOpenedAt : recipient.lastClickedAt;
    const update: Record<string, unknown> = {};
    if (client.isLikelyAutomated) {
      update[scannerCountField] = FieldValue.increment(1);
    } else {
      update[countField] = FieldValue.increment(1);
    }
    if (
      !client.isLikelyAutomated &&
      (!firstTimestamp || now.toMillis() < firstTimestamp.toMillis())
    ) {
      update[eventType === "open" ? "firstOpenedAt" : "firstClickedAt"] = now;
    }
    if (
      !client.isLikelyAutomated &&
      (!lastTimestamp || now.toMillis() > lastTimestamp.toMillis())
    ) {
      update[eventType === "open" ? "lastOpenedAt" : "lastClickedAt"] = now;
    }

    const event: EmailTrackingEventDoc = {
      tokenHash,
      campaignId: recipient.campaignId,
      eventType,
      occurredAt: now,
      expiresAt: Timestamp.fromMillis(
        now.toMillis() + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ),
      clientCategory: client.category,
      isLikelyAutomated: client.isLikelyAutomated,
    };

    if (Object.keys(update).length > 0) {
      transaction.update(recipientRef, update);
    }
    const summaryRef = db
      .collection(CAMPAIGN_SUMMARY_SHARDS_COLLECTION)
      .doc(campaignSummaryShardId(recipient.campaignId, attemptKey));
    const summaryUpdate: Record<string, unknown> = {
      campaignId: recipient.campaignId,
      updatedAt: now,
      [client.isLikelyAutomated
        ? eventType === "open"
          ? "scannerOpens"
          : "scannerClicks"
        : eventType === "open"
          ? "nonScannerOpens"
          : "nonScannerClicks"]: FieldValue.increment(1),
    };
    if (!client.isLikelyAutomated && !firstTimestamp) {
      summaryUpdate[
        eventType === "open"
          ? "uniqueNonScannerOpened"
          : "uniqueNonScannerClicked"
      ] = FieldValue.increment(1);
    }
    transaction.set(summaryRef, summaryUpdate, { merge: true });
    transaction.set(eventRef, event);
    return recipient;
  });

  recentEventAttempts.set(attemptKey, {
    expiresAt: result
      ? Date.UTC(
          now.toDate().getUTCFullYear(),
          now.toDate().getUTCMonth(),
          now.toDate().getUTCDate() + 1,
        )
      : Date.now() + MISSING_RECIPIENT_CACHE_TTL_MS,
    recipient: result,
  });
  return result;
}

export function registerEmailTrackingRoutes(app: Express, db: Firestore): void {
  app.post("/internal/email-tracking/recipients", async (req, res) => {
    const auth = requireAdmin(req);
    if (auth === "unconfigured") {
      return res.status(503).json({ error: "email_tracking_not_configured" });
    }
    if (auth === "forbidden") {
      return res.status(403).json({ error: "forbidden" });
    }

    let baseUrl: string;
    try {
      baseUrl = publicBaseUrl();
      trackingSigningSecrets();
    } catch {
      return res.status(503).json({ error: "email_tracking_not_configured" });
    }

    try {
      const input = parseCreateEmailTrackingInput(req.body);
      const signingSecrets = trackingSigningSecrets();
      const sentAtMillis = new Date(input.sentAt).getTime();
      const nowMillis = Date.now();
      const sentAtOutOfRange =
        sentAtMillis < nowMillis - 7 * 24 * 60 * 60 * 1000 ||
        sentAtMillis > nowMillis + 30 * 24 * 60 * 60 * 1000;
      const expiresAtMillis =
        sentAtMillis +
        RECIPIENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const expiresAtSeconds = Math.floor(expiresAtMillis / 1000);
      if (expiresAtSeconds <= Math.floor(Date.now() / 1000)) {
        return res.status(400).json({ error: "sent_at_too_old" });
      }
      const token = deriveTrackingToken(
        signingSecrets[0]!,
        input.campaignId,
        input.idempotencyKey,
        expiresAtSeconds,
      );
      const tokenHash = hashTrackingToken(token);
      const recipientId = `r_${tokenHash.slice(0, 24)}`;
      const registrationFingerprint = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const now = Timestamp.now();
      const recipient: EmailTrackingRecipientDoc = {
        campaignId: input.campaignId,
        recipientId,
        registrationFingerprint,
        destinationUrl: input.destinationUrl,
        createdAt: now,
        expiresAt: Timestamp.fromMillis(expiresAtSeconds * 1000),
        openCount: 0,
        scannerOpenCount: 0,
        clickCount: 0,
        scannerClickCount: 0,
        ...(input.industry ? { industry: input.industry } : {}),
        ...(input.subjectVariant
          ? { subjectVariant: input.subjectVariant }
          : {}),
        ...(input.bodyVariant ? { bodyVariant: input.bodyVariant } : {}),
        sentAt: Timestamp.fromDate(new Date(input.sentAt)),
      };

      const recipientRef = db.collection(RECIPIENTS_COLLECTION).doc(tokenHash);
      const registrationRef = db
        .collection(REGISTRATIONS_COLLECTION)
        .doc(
          createHash("sha256")
            .update(`${input.campaignId}:\0${input.idempotencyKey}`)
            .digest("hex"),
        );
      const registration = await db.runTransaction(async (transaction) => {
        const registrationSnapshot = await transaction.get(registrationRef);
        if (registrationSnapshot.exists) {
          const existing = registrationSnapshot.data() as {
            registrationFingerprint: string;
            tokenHash: string;
            recipientId: string;
            expiresAtSeconds: number;
          };
          const existingToken = signingSecrets
            .map((secret) =>
              deriveTrackingToken(
                secret,
                input.campaignId,
                input.idempotencyKey,
                existing.expiresAtSeconds,
              ),
            )
            .find(
              (candidateToken) =>
                hashTrackingToken(candidateToken) === existing.tokenHash,
            );
          if (!existingToken) {
            throw new Error("signing key ring cannot reproduce existing token");
          }
          if (existing.expiresAtSeconds <= Math.floor(Date.now() / 1000)) {
            return {
              ok: false,
              token: existingToken,
              recipientId: existing.recipientId,
              error: "registration_expired",
            };
          }
          return {
            ok:
              existing.registrationFingerprint === registrationFingerprint,
            token: existingToken,
            recipientId: existing.recipientId,
          };
        }
        if (sentAtOutOfRange) {
          return {
            ok: false,
            token,
            recipientId,
            error: "sent_at_out_of_range",
          };
        }
        transaction.create(recipientRef, recipient);
        transaction.create(registrationRef, {
          campaignId: input.campaignId,
          registrationFingerprint,
          tokenHash,
          recipientId,
          expiresAtSeconds,
          expiresAt: recipient.expiresAt,
          createdAt: now,
        });
        transaction.set(
          db
            .collection(CAMPAIGN_SUMMARY_SHARDS_COLLECTION)
            .doc(campaignSummaryShardId(input.campaignId, tokenHash)),
          {
            campaignId: input.campaignId,
            recipientCount: FieldValue.increment(1),
            updatedAt: now,
          },
          { merge: true },
        );
        return { ok: true, token, recipientId };
      });
      if ("error" in registration) {
        const status = registration.error === "registration_expired" ? 410 : 400;
        return res.status(status).json({ error: registration.error });
      }
      if (!registration.ok) {
        return res.status(409).json({ error: "idempotency_conflict" });
      }
      return res.status(201).json({
        token: registration.token,
        recipientId: registration.recipientId,
        openPixelUrl: `${baseUrl}/t/o/${registration.token}.gif`,
        clickUrl: `${baseUrl}/t/c/${registration.token}`,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ error: "invalid_request" });
      }
      if (error instanceof Error && error.message.startsWith("destinationUrl")) {
        return res
          .status(400)
          .json({ error: "invalid_request", message: error.message });
      }
      if (
        error instanceof Error &&
        (error.message.includes("campaignId") ||
          error.message.includes("idempotencyKey") ||
          error.message.includes("request body") ||
          error.message.includes("sentAt") ||
          error.message.includes("opaque identifier") ||
          error.message.includes("must be a string"))
      ) {
        return res
          .status(400)
          .json({ error: "invalid_request", message: error.message });
      }
      console.error("[email-tracking] recipient creation failed");
      return res.status(500).json({ error: "recipient_creation_failed" });
    }
  });

  app.get("/t/o/:token.gif", async (req, res) => {
    const token = req.params.token;
    let authentic = false;
    try {
      authentic =
        Boolean(token) &&
        trackingSigningSecrets().some((secret) =>
          isAuthenticTrackingToken(token, secret),
        );
    } catch {
      authentic = false;
    }
    if (token && authentic) {
      try {
        await recordEvent(
          db,
          hashTrackingToken(token),
          "open",
          req.get("user-agent") || "",
        );
      } catch {
        console.warn("[email-tracking] open event write failed");
      }
    }

    res.set({
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
    });
    return res.status(200).send(TRANSPARENT_GIF);
  });

  app.get("/t/c/:token", async (req, res) => {
    const token = req.params.token;
    let authentic = false;
    try {
      authentic =
        Boolean(token) &&
        trackingSigningSecrets().some((secret) =>
          isAuthenticTrackingToken(token, secret),
        );
    } catch {
      authentic = false;
    }
    if (!token || !authentic) {
      return res.status(404).send("Not found");
    }

    const tokenHash = hashTrackingToken(token);
    let recipient: EmailTrackingRecipientDoc | null = null;
    try {
      recipient = await recordEvent(
        db,
        tokenHash,
        "click",
        req.get("user-agent") || "",
        true,
      );
    } catch (error) {
      console.warn("[email-tracking] click event write failed");
      try {
        const snapshot = await db
          .collection(RECIPIENTS_COLLECTION)
          .doc(tokenHash)
          .get();
        if (snapshot.exists) {
          const fallbackRecipient =
            snapshot.data() as EmailTrackingRecipientDoc;
          if (fallbackRecipient.expiresAt.toMillis() > Date.now()) {
            recipient = fallbackRecipient;
          }
        }
      } catch {
        return res.status(503).send("Temporarily unavailable");
      }
    }
    if (!recipient) return res.status(404).send("Not found");
    let destinationUrl: string;
    try {
      destinationUrl = normalizeHttpsDestination(recipient.destinationUrl);
    } catch {
      return res.status(500).send("Invalid destination");
    }
    res.set("Referrer-Policy", "no-referrer");
    return res.redirect(302, destinationUrl);
  });

  app.get(
    "/internal/email-tracking/campaigns/:campaignId/summary",
    async (req, res) => {
      const auth = requireAdmin(req);
      if (auth === "unconfigured") {
        return res.status(503).json({ error: "email_tracking_not_configured" });
      }
      if (auth === "forbidden") {
        return res.status(403).json({ error: "forbidden" });
      }

      const campaignId = req.params.campaignId;
      if (!campaignId || !IDENTIFIER_PATTERN.test(campaignId)) {
        return res.status(400).json({ error: "invalid_campaign_id" });
      }

      try {
        const snapshot = await db
          .collection(CAMPAIGN_SUMMARY_SHARDS_COLLECTION)
          .where("campaignId", "==", campaignId)
          .get();
        if (snapshot.size === 0) {
          return res.status(404).json({ error: "campaign_not_found" });
        }
        const summary: Record<string, number> = {};
        for (const doc of snapshot.docs) {
          const shard = doc.data() as Record<string, unknown>;
          for (const field of [
            "recipientCount",
            "uniqueNonScannerOpened",
            "uniqueNonScannerClicked",
            "nonScannerOpens",
            "nonScannerClicks",
            "scannerOpens",
            "scannerClicks",
          ]) {
            summary[field] =
              (summary[field] || 0) + Number(shard[field] || 0);
          }
        }
        const recipients = summary.recipientCount || 0;
        const uniqueOpened = summary.uniqueNonScannerOpened || 0;
        const uniqueClicked = summary.uniqueNonScannerClicked || 0;

        return res.json({
          campaignId,
          recipients,
          uniqueNonScannerOpened: uniqueOpened,
          uniqueNonScannerClicked: uniqueClicked,
          nonScannerOpens: summary.nonScannerOpens || 0,
          nonScannerClicks: summary.nonScannerClicks || 0,
          scannerOpens: summary.scannerOpens || 0,
          scannerClicks: summary.scannerClicks || 0,
          nonScannerOpenRate:
            recipients > 0 ? uniqueOpened / recipients : null,
          nonScannerClickRate:
            recipients > 0 ? uniqueClicked / recipients : null,
          measurementBasis: "known_scanners_excluded",
        });
      } catch (error) {
        console.error("[email-tracking] summary failed", error);
        return res.status(500).json({ error: "summary_failed" });
      }
    },
  );
}
