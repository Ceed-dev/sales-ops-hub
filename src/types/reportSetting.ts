// -----------------------------------------------------------------------------
// ReportSetting Schema (v1)
// Minimal configuration for automated report generation.
// - Scheduling & AI params are code/ENV driven (not stored here).
// - Firestore stores *who to send to* and lightweight ops metadata.
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";

export type ReportTarget = {
  /** Entity type */
  type: "chat" | "team" | "user" | "org";
  /** Target ID (e.g., Telegram chatId) */
  id: string;
};

export interface ReportSetting {
  // --- Identity / Labels (optional, for human readability) ---
  /** Display name for this setting (e.g., "JP Sales Weekly") */
  name: string;
  /** Free-form tags to organize settings (e.g., ["sales", "jp-team"]) */
  tags?: string[];
  /** Owner/point of contact (email or user ID) */
  owner?: string;

  // --- Target (required) ---
  /** Whether this setting is enabled */
  enabled: boolean;
  /** Target entity for which the report is generated */
  target: ReportTarget;

  // --- Output destinations (optional; falls back to code defaults) ---
  output: {
    slack?: { channel: string };
    gdoc?: { folderId: string };
    gdrive?: { folderId: string };
    /** Reserved for future integrations */
    other?: Record<string, any>;
  };

  // --- Operational state (optional; maintained by the job runner) ---
  /** Last time this setting attempted to run */
  lastRunAt?: Timestamp;
  /** Last time this setting successfully completed */
  lastSuccessAt?: Timestamp;
  /** Last error info for troubleshooting */
  lastError?: {
    message: string;
    at: Timestamp;
  };

  // --- Firestore metadata ---
  /** Server timestamps on create/update */
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
