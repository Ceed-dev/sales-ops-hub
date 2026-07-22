import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import type { Firestore } from "firebase-admin/firestore";

import { registerEmailTrackingRoutes } from "./emailTracking.js";

type StoredDoc = Record<string, unknown>;

class FakeSnapshot {
  constructor(private readonly value?: StoredDoc) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): StoredDoc | undefined {
    return this.value;
  }
}

class FakeDocumentRef {
  constructor(
    private readonly store: Map<string, StoredDoc>,
    readonly path: string,
  ) {}

  async get(): Promise<FakeSnapshot> {
    return new FakeSnapshot(this.store.get(this.path));
  }
}

class FakeTransaction {
  constructor(private readonly store: Map<string, StoredDoc>) {}

  async get(ref: FakeDocumentRef): Promise<FakeSnapshot> {
    return ref.get();
  }

  create(ref: FakeDocumentRef, value: StoredDoc): void {
    if (this.store.has(ref.path)) throw new Error("already exists");
    this.store.set(ref.path, { ...value });
  }

  set(
    ref: FakeDocumentRef,
    value: StoredDoc,
    options?: { merge?: boolean },
  ): void {
    const next = options?.merge
      ? { ...(this.store.get(ref.path) || {}) }
      : {};
    this.applyValues(next, value);
    this.store.set(ref.path, next);
  }

  update(ref: FakeDocumentRef, update: StoredDoc): void {
    const current = this.store.get(ref.path);
    if (!current) throw new Error("not found");
    const next = { ...current };
    this.applyValues(next, update);
    this.store.set(ref.path, next);
  }

  private applyValues(target: StoredDoc, update: StoredDoc): void {
    for (const [key, value] of Object.entries(update)) {
      if (
        value &&
        typeof value === "object" &&
        "operand" in value &&
        typeof (value as { operand?: unknown }).operand === "number"
      ) {
        target[key] =
          Number(target[key] || 0) + (value as { operand: number }).operand;
      } else {
        target[key] = value;
      }
    }
  }
}

class FakeQuery {
  private maximum = Number.POSITIVE_INFINITY;

  constructor(
    private readonly store: Map<string, StoredDoc>,
    private readonly collectionName: string,
    private readonly field: string,
    private readonly expected: unknown,
  ) {}

  limit(maximum: number): this {
    this.maximum = maximum;
    return this;
  }

  async get(): Promise<{ docs: FakeSnapshot[]; size: number }> {
    const prefix = `${this.collectionName}/`;
    const docs = [...this.store.entries()]
      .filter(
        ([path, value]) =>
          path.startsWith(prefix) && value[this.field] === this.expected,
      )
      .slice(0, this.maximum)
      .map(([, value]) => new FakeSnapshot(value));
    return { docs, size: docs.length };
  }
}

class FakeCollection {
  constructor(
    private readonly store: Map<string, StoredDoc>,
    private readonly name: string,
  ) {}

  doc(id = `auto_${this.store.size}`): FakeDocumentRef {
    return new FakeDocumentRef(this.store, `${this.name}/${id}`);
  }

  where(field: string, operator: string, expected: unknown): FakeQuery {
    assert.equal(operator, "==");
    return new FakeQuery(this.store, this.name, field, expected);
  }
}

class FakeFirestore {
  readonly store = new Map<string, StoredDoc>();
  transactionCalls = 0;

  collection(name: string): FakeCollection {
    return new FakeCollection(this.store, name);
  }

  async runTransaction<T>(
    callback: (transaction: FakeTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    return callback(new FakeTransaction(this.store));
  }
}

async function withTrackingServer(
  run: (baseUrl: string, db: FakeFirestore) => Promise<void>,
): Promise<void> {
  const db = new FakeFirestore();
  const app = express();
  app.use(express.json());
  registerEmailTrackingRoutes(app, db as unknown as Firestore);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`, db);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("tracking routes authenticate, register idempotently, track and summarize", async () => {
  process.env.EMAIL_TRACKING_ADMIN_TOKEN = "x".repeat(32);
  process.env.EMAIL_TRACKING_SIGNING_SECRET = "s".repeat(32);
  process.env.PUBLIC_BASE_URL = "https://tracker.example.test";

  await withTrackingServer(async (baseUrl, db) => {
    const forbidden = await fetch(
      `${baseUrl}/internal/email-tracking/recipients`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(forbidden.status, 403);

    const registrationBody = {
      campaignId: "test_campaign",
      idempotencyKey: "opaque_key_123456",
      destinationUrl: "https://ceed.cloud/contact",
      sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const register = (overrides: Record<string, unknown> = {}) =>
      fetch(`${baseUrl}/internal/email-tracking/recipients`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-email-tracking-admin-token": "x".repeat(32),
        },
        body: JSON.stringify({ ...registrationBody, ...overrides }),
      });

    const first = await register();
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      token: string;
      openPixelUrl: string;
      clickUrl: string;
    };
    process.env.EMAIL_TRACKING_SIGNING_SECRET = JSON.stringify([
      "n".repeat(32),
      "s".repeat(32),
    ]);
    const second = await register();
    assert.equal(second.status, 201);
    assert.equal(
      ((await second.json()) as { token: string }).token,
      firstBody.token,
    );
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 8 * 24 * 60 * 60 * 1000;
    try {
      const delayedRetry = await register();
      assert.equal(delayedRetry.status, 201);
      assert.equal(
        ((await delayedRetry.json()) as { token: string }).token,
        firstBody.token,
      );
    } finally {
      Date.now = originalDateNow;
    }
    const conflict = await register({ subjectVariant: "subject_b" });
    assert.equal(conflict.status, 409);
    const tooFarFuture = await register({
      idempotencyKey: "opaque_future_12345",
      sentAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    });
    assert.equal(tooFarFuture.status, 400);

    const gif = await fetch(
      `${baseUrl}/t/o/${firstBody.token}.gif`,
      { headers: { "user-agent": "GoogleImageProxy" } },
    );
    assert.equal(gif.status, 200);
    assert.equal(gif.headers.get("content-type"), "image/gif");
    assert.ok((await gif.arrayBuffer()).byteLength > 0);

    const click = await fetch(
      `${baseUrl}/t/c/${firstBody.token}`,
      { redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } },
    );
    assert.equal(click.status, 302);
    assert.equal(click.headers.get("location"), "https://ceed.cloud/contact");
    assert.equal(click.headers.get("referrer-policy"), "no-referrer");

    const scannerClick = await fetch(
      `${baseUrl}/t/c/${firstBody.token}`,
      {
        redirect: "manual",
        headers: { "user-agent": "Proofpoint URL Scanner" },
      },
    );
    assert.equal(scannerClick.status, 302);

    const summary = await fetch(
      `${baseUrl}/internal/email-tracking/campaigns/test_campaign/summary`,
      {
        headers: {
          "x-email-tracking-admin-token": "x".repeat(32),
        },
      },
    );
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), {
      campaignId: "test_campaign",
      recipients: 1,
      uniqueNonScannerOpened: 1,
      uniqueNonScannerClicked: 1,
      nonScannerOpens: 1,
      nonScannerClicks: 1,
      scannerOpens: 0,
      scannerClicks: 1,
      nonScannerOpenRate: 1,
      nonScannerClickRate: 1,
      measurementBasis: "known_scanners_excluded",
    });
    assert.equal(
      [...db.store.keys()].filter((key) =>
        key.startsWith("emailTrackingRecipients/"),
      ).length,
      1,
    );
    const recipientKey = [...db.store.keys()].find((key) =>
      key.startsWith("emailTrackingRecipients/"),
    );
    assert.ok(recipientKey);
    db.store.delete(recipientKey);
    const revokedClick = await fetch(
      `${baseUrl}/t/c/${firstBody.token}`,
      { redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } },
    );
    assert.equal(revokedClick.status, 404);
  });
});

test("unknown pixels remain a valid non-cached GIF", async () => {
  process.env.EMAIL_TRACKING_ADMIN_TOKEN = "x".repeat(32);
  process.env.EMAIL_TRACKING_SIGNING_SECRET = "s".repeat(32);
  process.env.PUBLIC_BASE_URL = "https://tracker.example.test";

  await withTrackingServer(async (baseUrl, db) => {
    const response = await fetch(
      `${baseUrl}/t/o/${"A".repeat(43)}.gif`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    assert.equal(db.transactionCalls, 0);
  });
});
