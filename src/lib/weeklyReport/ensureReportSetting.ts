// -----------------------------------------------------------------------------
// Ensure a default ReportSetting document exists for a given target.
//
// Characteristics
// - Idempotent: creates once; never overwrites an existing doc.
// - Minimal input: `target` is required; all others are optional.
// - Doc ID format: "<target.type>:<target.id>:weekly" (":" is Firestore-safe).
// - Timestamps: createdAt/updatedAt use server-side timestamps.
// - Return: boolean (true when created, false when it already existed).
// -----------------------------------------------------------------------------

import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import type { ReportTarget, ReportSetting } from "../../types/reportSetting.js";

// ===== Types (local) =====

export type EnsureReportSettingInput = {
  target: ReportTarget; // required
  name?: string; // optional label
  enabled?: boolean; // default: true
  owner?: string;
  tags?: string[];
  output?: {
    slack?: { channel: string };
    gdoc?: { folderId: string };
    gdrive?: { folderId: string };
    other?: Record<string, unknown>;
  };
};

// ===== Public API =====

/**
 * Ensure a default ReportSetting exists for the given target.
 * - Creates a new doc with safe defaults if missing.
 * - Does nothing (returns false) when the doc already exists.
 */
export async function ensureReportSetting(
  input: EnsureReportSettingInput,
): Promise<boolean> {
  const { target } = input;
  assertTarget(target);

  const id = buildReportSettingId(target, "weekly");
  const ref = db.collection("reports_settings").doc(id);

  let created = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return; // already exists → idempotent

    const nowServer = FieldValue.serverTimestamp();

    // Minimal, valid ReportSetting payload (only persist what we have)
    const data: ReportSetting = {
      // Identity / labels (optional)
      ...(input.name ? { name: input.name } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.owner ? { owner: input.owner } : {}),

      // Target (required)
      enabled: input.enabled ?? true,
      target: { type: target.type, id: target.id },

      // Output destinations (optional)
      output: buildOutput(input.output),

      // Operational state: omitted on create (filled by the runner)

      // Firestore metadata
      createdAt: nowServer as any, // cast for TS; runtime is server timestamp
      updatedAt: nowServer as any,
    };

    tx.create(ref, data);
    created = true;
  });

  return created;
}

// ===== Helpers =====

/** Build Firestore document ID: "<type>:<id>:<cadence>" */
export function buildReportSettingId(
  target: ReportTarget,
  cadence: string = "weekly",
): string {
  // Firestore prohibits "/" in doc IDs; ":" is fine.
  return `${target.type}:${target.id}:${cadence}`;
}

/** Validate presence of target.type and target.id */
function assertTarget(target: ReportTarget): void {
  if (!target?.type || !target?.id) {
    throw new Error(
      "ensureReportSetting: target.type and target.id are required",
    );
  }
}

/** Build the 'output' field while dropping empty/undefined branches */
function buildOutput(
  input?: EnsureReportSettingInput["output"],
): ReportSetting["output"] {
  const out: ReportSetting["output"] = {};
  if (input?.slack?.channel) out.slack = { channel: input.slack.channel };
  if (input?.gdoc?.folderId) out.gdoc = { folderId: input.gdoc.folderId };
  if (input?.gdrive?.folderId) out.gdrive = { folderId: input.gdrive.folderId };
  if (input?.other && Object.keys(input.other).length) out.other = input.other;
  return out;
}
