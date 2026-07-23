#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { google } from "googleapis";

const execFileAsync = promisify(execFile);
const CLIENT_PATH =
  process.env.GMAIL_OAUTH_CLIENT_PATH ||
  "/Users/zacky/Library/Application Support/Ceed/outreach/gmail-oauth-client.json";
const TOKEN_PATH =
  process.env.GMAIL_OAUTH_TOKEN_PATH ||
  "/Users/zacky/Library/Application Support/Ceed/outreach/gmail-oauth.json";
const AUTH_URL_PATH =
  process.env.GMAIL_AUTH_URL_PATH ||
  "/private/tmp/ceed-gmail-auth-url.txt";
const EXPECTED_EMAIL = "yusaku.takahashi@ceed.cloud";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

const clientConfig = JSON.parse(await readFile(CLIENT_PATH, "utf8")).installed;
if (!clientConfig?.client_id || !clientConfig?.client_secret) {
  throw new Error("OAuth desktop client configuration is invalid");
}

let resolveCode;
let rejectCode;
const expectedState = randomBytes(24).toString("base64url");
const codePromise = new Promise((resolve, reject) => {
  resolveCode = resolve;
  rejectCode = reject;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.searchParams.get("error")) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization was not completed. You can close this window.");
    rejectCode(new Error(`OAuth error: ${url.searchParams.get("error")}`));
    return;
  }
  const receivedState = url.searchParams.get("state") || "";
  const expectedStateBuffer = Buffer.from(expectedState);
  const receivedStateBuffer = Buffer.from(receivedState);
  if (
    receivedStateBuffer.length !== expectedStateBuffer.length ||
    !timingSafeEqual(receivedStateBuffer, expectedStateBuffer)
  ) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization state is invalid.");
    rejectCode(new Error("OAuth state validation failed"));
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization code is missing.");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Gmail send authorization completed. You can close this window.");
  resolveCode(code);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Could not start OAuth callback server");
}
const redirectUri = `http://localhost:${address.port}`;
const oauth2 = new google.auth.OAuth2(
  clientConfig.client_id,
  clientConfig.client_secret,
  redirectUri,
);
const authorizationUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: false,
  scope: SCOPES,
  state: expectedState,
});

await writeFile(AUTH_URL_PATH, authorizationUrl, { mode: 0o600 });
if (process.env.GMAIL_AUTH_NO_OPEN !== "1") {
  await execFileAsync("open", [authorizationUrl]);
}

try {
  const code = await codePromise;
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("OAuth response did not include a refresh token");
  }
  oauth2.setCredentials(tokens);
  const oauthApi = google.oauth2({ version: "v2", auth: oauth2 });
  const profile = await oauthApi.userinfo.get();
  if (profile.data.email !== EXPECTED_EMAIL) {
    throw new Error(
      `Authorized account is ${profile.data.email || "unknown"}, expected ${EXPECTED_EMAIL}`,
    );
  }

  await mkdir(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  await writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        client_id: clientConfig.client_id,
        client_secret: clientConfig.client_secret,
        refresh_token: tokens.refresh_token,
        scope: SCOPES,
        authorized_email: profile.data.email,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(TOKEN_PATH, 0o600);
  console.log(`Authorized Gmail send for ${profile.data.email}`);
} finally {
  server.close();
}
