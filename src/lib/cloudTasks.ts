// -----------------------------------------------------------------------------
// Cloud Tasks utilities
// - Provides a helper to enqueue HTTP tasks with ETA scheduling
// -----------------------------------------------------------------------------

import { CloudTasksClient } from "@google-cloud/tasks";
import { Timestamp } from "firebase-admin/firestore";

// --- Environment variables ---
const project = process.env.GCP_PROJECT_ID!;
const location = process.env.GCP_LOCATION_ID!;
const queue = process.env.GCP_TASKS_QUEUE!;

// --- Client ---
const client = new CloudTasksClient();

/**
 * Enqueues an HTTP task in Google Cloud Tasks with a scheduled ETA.
 *
 * @param opts.url - Target endpoint URL (e.g., "/tasks/notify")
 * @param opts.payload - JSON payload to send in the request body
 * @param opts.scheduledAt - Firestore Timestamp (UTC) representing execution time
 * @returns The created task name (string) or empty string if not returned
 */
export async function enqueueHttpEtaTask(opts: {
  url: string;
  payload: Record<string, any>;
  scheduledAt: Timestamp;
}): Promise<string> {
  const parent = client.queuePath(project, location, queue);

  const body = Buffer.from(JSON.stringify(opts.payload)).toString("base64");

  const task = {
    httpRequest: {
      httpMethod: "POST" as const,
      url: opts.url,
      headers: { "Content-Type": "application/json" },
      body,
    },
    scheduleTime: {
      seconds: opts.scheduledAt.seconds,
      nanos: opts.scheduledAt.nanoseconds,
    },
  };

  const [resp] = await client.createTask({ parent, task });
  return resp?.name ?? "";
}
