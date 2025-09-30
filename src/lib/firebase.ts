// -----------------------------------------------------------------------------
// Firebase Admin SDK initialization
// - Exports a Firestore instance (`db`) for use across the app
// - Chooses credentials from GOOGLE_APPLICATION_CREDENTIALS (if present),
//   otherwise falls back to Application Default Credentials (ADC).
// -----------------------------------------------------------------------------

import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";

// --- Environment variables ---
const projectId = process.env.FIREBASE_PROJECT_ID!;

/**
 * Select credentials:
 * - If GOOGLE_APPLICATION_CREDENTIALS is set and file exists → use cert()
 * - Otherwise → fallback to applicationDefault()
 */
const cred =
  process.env.GOOGLE_APPLICATION_CREDENTIALS &&
  fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    ? cert(
        JSON.parse(
          fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"),
        ),
      )
    : applicationDefault();

// --- Initialize Firebase Admin ---
initializeApp({ credential: cred, projectId });

// --- Firestore export ---
export const db = getFirestore();
