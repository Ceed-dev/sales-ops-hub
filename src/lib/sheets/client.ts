import { google } from "googleapis";

/** OAuth scopes for Google Sheets API */
const SCOPES: string[] = ["https://www.googleapis.com/auth/spreadsheets"];

/**
 * Returns a GoogleAuth instance.
 * - Local: uses JSON key if GOOGLE_APPLICATION_CREDENTIALS is set.
 * - Cloud Run: falls back to ADC (attached service account).
 */
export function getGoogleAuth() {
  const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return keyFilename
    ? new google.auth.GoogleAuth({ keyFilename, scopes: SCOPES })
    : new google.auth.GoogleAuth({ scopes: SCOPES });
}

/**
 * Creates and returns a Google Sheets API client (v4).
 */
export function getSheetsClient() {
  const auth = getGoogleAuth();
  // Pass the GoogleAuth instance itself; Google SDK will resolve credentials.
  return google.sheets({ version: "v4", auth });
}
