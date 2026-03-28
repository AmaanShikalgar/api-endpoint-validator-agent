import endpoints from "./endpoints.json";
import { Composio } from "@composio/core";

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  throw new Error(
    "COMPOSIO_API_KEY is not set. Create an API key in Composio and run with COMPOSIO_API_KEY=<key>."
  );
}

const composio = new Composio({
  apiKey,
});

// This file loads and displays the endpoint definitions you need to test.
// Use this as a starting point to understand the input data.
//
// Hint: Use composio.tools.proxyExecute() to test endpoints. Example:
//   const result = await composio.tools.proxyExecute({
//     endpoint: "/gmail/v1/users/me/messages",
//     method: "GET",
//     connectedAccountId: "candidate",
//     parameters: [{ in: "query", name: "maxResults", value: 5 }],
//   });

const gmailEndpoints = endpoints.gmail.endpoints;
const calendarEndpoints = endpoints.googlecalendar.endpoints;

console.log(`\n=== Endpoint Summary ===\n`);
console.log(`Gmail endpoints: ${gmailEndpoints.length}`);
console.log(`Google Calendar endpoints: ${calendarEndpoints.length}`);
console.log(`Total: ${gmailEndpoints.length + calendarEndpoints.length}\n`);

console.log("--- Gmail ---");
for (const ep of gmailEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log("\n--- Google Calendar ---");
for (const ep of calendarEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log(`\nRequired scopes (union):`);
const allScopes = new Set([
  ...gmailEndpoints.flatMap((e) => e.required_scopes),
  ...calendarEndpoints.flatMap((e) => e.required_scopes),
]);
for (const scope of allScopes) {
  console.log(`  ${scope}`);
}

let cachedMessageId: string | null= null;
let cachedEventId: string | null= null;
let cachedGmailEmail: string | null = null;

function normalizeGoogleCalendarEndpoint(endpointPath: string) {
  // `@composio/core` proxy seems to already prefix `/calendar/v3`.
  // When we pass endpoints that already start with `/calendar/v3/...`,
  // the final URL becomes `/calendar/v3/calendar/v3/...` (404).
  return endpointPath.replace(/^\/calendar\/v3/, "");
}

async function getMessageId() {
  if (cachedMessageId) return cachedMessageId;

  const res = await composio.tools.proxyExecute({
    // List messages so we can grab the first `id`
    endpoint: "/gmail/v1/users/me/messages",
    method: "GET",
    connectedAccountId: "ca_NQSBTq5CWC8H",
    parameters: [{ in: "query", name: "maxResults", value: 1 }]
  });

  const id = (res.data as any)?.messages?.[0]?.id;
  if (!id) throw new Error("No messageId found");

  cachedMessageId = id;
  return id;
}

async function getEventId() {
  if (cachedEventId) return cachedEventId;

  const connectedAccountId = "ca_AUFz8joVqF9J";

  // Try to find an upcoming event first.
  const now = Date.now();
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  const res = await composio.tools.proxyExecute({
    endpoint: normalizeGoogleCalendarEndpoint("/calendar/v3/calendars/primary/events"),
    method: "GET",
    connectedAccountId,
    parameters: [
      { in: "query", name: "maxResults", value: 1 },
      { in: "query", name: "timeMin", value: timeMin },
      { in: "query", name: "timeMax", value: timeMax },
      // Keep these as strings/numbers to satisfy our parameter type.
      { in: "query", name: "singleEvents", value: "true" },
      { in: "query", name: "orderBy", value: "startTime" },
    ],
  });

  const idFromList = (res.data as any)?.items?.[0]?.id;
  if (idFromList) {
    cachedEventId = idFromList;
    return idFromList;
  }

  // If there are no events, create a test event and use its id.
  const createParams = await getParams({ tool_slug: "GOOGLECALENDAR_CREATE_EVENT" });
  if (!createParams.body) throw new Error("No create event body available");

  const created = await composio.tools.proxyExecute({
    endpoint: normalizeGoogleCalendarEndpoint("/calendar/v3/calendars/primary/events"),
    method: "POST",
    connectedAccountId,
    body: createParams.body as any,
  });

  const createdId = (created.data as any)?.id;
  if (!createdId) throw new Error("No eventId found (even after creating event)");

  cachedEventId = createdId;
  return createdId;
}

async function getGmailEmail() {
  if (cachedGmailEmail) return cachedGmailEmail;

  const res = await composio.tools.proxyExecute({
    endpoint: "/gmail/v1/users/me/profile",
    method: "GET",
    connectedAccountId: "ca_NQSBTq5CWC8H",
    parameters: [],
  });

  const email = (res.data as any)?.emailAddress;
  if (!email) throw new Error("No gmail emailAddress found in profile");

  cachedGmailEmail = email;
  return email;
}

type GetParamsResult = {
  body?: Record<string, unknown>;
  // `proxyExecute` expects `parameters`, matching the example in this file.
  parameters?: Array<{
    in: "header" | "query";
    name: string;
    value: string | number;
  }>;
};

async function getParams(ep: any): Promise<GetParamsResult> {
  // Gmail SEND
  if (ep.tool_slug === "GMAIL_SEND_MESSAGE") {
    const email = await getGmailEmail();
    const raw =
      `From: ${email}\r\nTo: ${email}\r\nSubject: Test\r\n\r\nHello from agent`;
    // Gmail API expects base64url (no '+', '/', '=' padding).
    const base64url = Buffer.from(raw, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    return {
      body: {
        raw: base64url,
      },
    };
  }

  // Gmail CREATE DRAFT
  if (ep.tool_slug === "GMAIL_CREATE_DRAFT") {
    const email = await getGmailEmail();
    const raw =
      `From: ${email}\r\nTo: ${email}\r\nSubject: Test draft\r\n\r\nHello from agent`;
    const base64url = Buffer.from(raw, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    // Create draft body requires the `message` wrapper.
    return {
      body: {
        message: {
          raw: base64url,
        },
      },
    };
  }

  // Gmail "Archive" is implemented by removing INBOX label.
  if (ep.tool_slug === "GMAIL_ARCHIVE_MESSAGE") {
    return {
      body: {
        removeLabelIds: ["INBOX"],
      },
    };
  }

  // Calendar CREATE
  if (ep.tool_slug === "GOOGLECALENDAR_CREATE_EVENT") {
    return {
      body: {
        summary: "Test Event",
        start: {
          dateTime: new Date().toISOString(),
          timeZone: "Asia/Kolkata",
        },
        end: {
          dateTime: new Date(Date.now() + 3600000).toISOString(),
          timeZone: "Asia/Kolkata",
        },
      },
    };
  }

  return {};
}

async function testEndpoint(ep: any): Promise<boolean> {
  try {
    const accountId = ep.tool_slug.includes("GMAIL")
      ? "ca_NQSBTq5CWC8H"
      : "ca_AUFz8joVqF9J";

    const params = await getParams(ep);

let endpointPath = ep.path;

// 🔥 replace path params manually
if (ep.path.includes("{messageId}")) {
  const id = await getMessageId();
  endpointPath = ep.path.replace("{messageId}", id);
}

if (ep.path.includes("{eventId}")) {
  const id = await getEventId();
  endpointPath = ep.path.replace("{eventId}", id);
}

if (ep.tool_slug === "GOOGLECALENDAR_LIST_REMINDERS") {
  const id = await getEventId();
  // Google Calendar does not expose a standalone `/reminders` sub-resource in many cases.
  // Fetch the event itself instead (it contains reminder info if present).
  endpointPath = `/calendar/v3/calendars/primary/events/${id}`;
}

// Gmail endpoint remaps: some "folder/archive" paths are not real Gmail REST endpoints.
if (ep.tool_slug === "GMAIL_LIST_FOLDERS") {
  endpointPath = "/gmail/v1/users/me/labels";
}

if (ep.tool_slug === "GMAIL_ARCHIVE_MESSAGE") {
  // Current endpoint path is ".../archive"; archive is implemented via "modify".
  endpointPath = endpointPath.replace(/\/archive$/, "/modify");
}

if (ep.tool_slug.includes("GOOGLECALENDAR")) {
  endpointPath = normalizeGoogleCalendarEndpoint(endpointPath);
}

const result = await composio.tools.proxyExecute({
  endpoint: endpointPath,
  method: ep.method,
  connectedAccountId: accountId,
  ...(params.body ? { body: params.body } : {}),
  ...(params.parameters ? { parameters: params.parameters } : {}),
});

    const success = result && result.status >= 200 && result.status < 300;

    const baseLog = {
      endpoint: ep.path,
      method: ep.method,
      tool: ep.tool_slug,
      status: success ? "PASS" : "FAIL",
    };

    if (!success) {
      console.log({
        ...baseLog,
        statusCode: (result as any)?.status,
        data: (result as any)?.data,
      });
    } else {
      console.log(baseLog);
    }

    // Cache the created event id so GET/DELETE can use it immediately.
    if (success && ep.tool_slug === "GOOGLECALENDAR_CREATE_EVENT") {
      const id = (result as any)?.data?.id;
      if (id) cachedEventId = id;
    }

    return Boolean(success);
  } catch (err: any) {
    console.log({
      endpoint: ep.path,
      method: ep.method,
      tool: ep.tool_slug,
      status: "ERROR",
      error: err?.message ?? String(err),
    });
    return false;
  }
}

async function runTests() {
  console.log("\n=== Running Gmail Tests ===");

  let gmailPass = 0;
  let gmailFail = 0;
  for (const ep of gmailEndpoints) {
    const ok = await testEndpoint(ep);
    if (ok) gmailPass++;
    else gmailFail++;
  }

  console.log("\n=== Running Calendar Tests ===");

  let calPass = 0;
  let calFail = 0;
  for (const ep of calendarEndpoints) {
    const ok = await testEndpoint(ep);
    if (ok) calPass++;
    else calFail++;
  }

  console.log("\n=== Summary ===");
  console.log({
    gmail: { pass: gmailPass, fail: gmailFail, total: gmailPass + gmailFail },
    calendar: { pass: calPass, fail: calFail, total: calPass + calFail },
    total: {
      pass: gmailPass + calPass,
      fail: gmailFail + calFail,
      total: gmailPass + gmailFail + calPass + calFail,
    },
  });
}

runTests();