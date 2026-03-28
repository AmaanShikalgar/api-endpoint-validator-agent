import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  ParameterDef,
  TestReport,
} from "./types";

type ProxyExecuteParams = {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  connectedAccountId: string;
  parameters?: Array<{ in: "query" | "header"; name: string; value: string | number }>;
  body?: unknown;
};

type ProxyExecuteResponse = {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
};

const MAX_RESPONSE_CHARS = 10_000;
const MAX_GRAPH_DEPTH = 10;

function nowIso() {
  return new Date().toISOString();
}

function base64UrlEncodeUtf8(input: string) {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function redactSensitiveText(input: string) {
  return input.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]"
  );
}

function truncateText(input: string, maxChars: number) {
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars) + `\n...[truncated ${input.length - maxChars} chars]`;
}

function safeResponseBody(body: unknown) {
  try {
    if (body == null) return body;
    if (typeof body === "string") {
      return truncateText(redactSensitiveText(body), MAX_RESPONSE_CHARS);
    }
    const json = JSON.stringify(body);
    const safe = truncateText(redactSensitiveText(json), MAX_RESPONSE_CHARS);
    if (safe === json) return body;
    return safe;
  } catch {
    return "[unserializable response_body]";
  }
}

function classify(statusCode: number | null): EndpointStatus {
  if (statusCode == null) return "error";
  if (statusCode >= 200 && statusCode < 300) return "valid";
  if (statusCode === 403) return "insufficient_scopes";
  if (statusCode === 404 || statusCode === 405) return "invalid_endpoint";
  return "error";
}

function summaryFor(status: EndpointStatus, http: number | null, hint?: string) {
  const base =
    status === "valid"
      ? "Received a successful 2xx response."
      : status === "invalid_endpoint"
        ? "Endpoint appears to not exist (404/405)."
        : status === "insufficient_scopes"
          ? "Endpoint exists but access was forbidden (likely missing scopes)."
          : "Request failed due to an error (non-2xx).";
  const code = http == null ? "" : ` (HTTP ${http})`;
  return hint ? `${base}${code} ${hint}` : `${base}${code}`;
}

function extractPathParams(path: string) {
  const params: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) params.push(m[1]);
  return params;
}

function buildQueryParams(def: EndpointDefinition) {
  const params: Array<{ in: "query"; name: string; value: string | number }> = [];
  const q = def.parameters?.query ?? [];

  const maxResults = q.find((p) => p.name.toLowerCase() === "maxresults");
  if (maxResults) params.push({ in: "query", name: maxResults.name, value: 1 });

  return params.length ? params : undefined;
}

function buildDateTimeObject() {
  return { dateTime: nowIso(), timeZone: "UTC" };
}

function valueFromField(field: ParameterDef) {
  const name = field.name.toLowerCase();
  const desc = field.description?.toLowerCase?.() ?? "";
  const type = field.type.toLowerCase();

  if (desc.includes("rfc 2822") && desc.includes("base64url")) {
    const raw =
      "From: test@example.com\r\nTo: test@example.com\r\nSubject: Test\r\n\r\nHello from agent";
    return base64UrlEncodeUtf8(raw);
  }

  if (name === "start" || name === "end") {
    if (desc.includes("datetime") || desc.includes("timezone")) return buildDateTimeObject();
  }

  if (type.includes("integer") || type.includes("number")) return 1;
  if (type.includes("boolean")) return true;
  if (type.includes("string")) {
    if (name.includes("timezone")) return "UTC";
    if (name.includes("datetime") || name.includes("time") || name.includes("date"))
      return nowIso();
    return "test";
  }
  if (type.includes("object")) return {};
  return "test";
}

function buildBody(def: EndpointDefinition) {
  const bodyDef = def.parameters?.body;
  if (!bodyDef) return undefined;

  const body: Record<string, unknown> = {};
  for (const field of bodyDef.fields) {
    if (!field.required) continue;

    const desc = field.description?.toLowerCase?.() ?? "";
    const fieldType = field.type.toLowerCase();

    if (fieldType.includes("object") && desc.includes("must include") && desc.includes("raw")) {
      const raw =
        "From: test@example.com\r\nTo: test@example.com\r\nSubject: Test\r\n\r\nHello from agent";
      body[field.name] = { raw: base64UrlEncodeUtf8(raw) };
      continue;
    }

    body[field.name] = valueFromField(field);
  }

  return Object.keys(body).length ? body : undefined;
}

function findFirstPrimitiveByKeys(data: unknown, keys: string[]): string | number | null {
  const lowered = new Set(keys.map((k) => k.toLowerCase()));
  const visited = new Set<unknown>();

  function walk(node: unknown, depth: number): string | number | null {
    if (node == null) return null;
    if (depth > MAX_GRAPH_DEPTH) return null;
    if (typeof node !== "object") return null;
    if (visited.has(node)) return null;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found != null) return found;
      }
      return null;
    }

    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (lowered.has(k.toLowerCase())) {
        if (typeof v === "string" || typeof v === "number") return v;
      }
    }

    for (const v of Object.values(rec)) {
      const found = walk(v, depth + 1);
      if (found != null) return found;
    }
    return null;
  }

  return walk(data, 0);
}

function tryFixDuplicatedPrefix(endpointPath: string, responseData: unknown) {
  if (typeof responseData !== "string") return null;
  if (endpointPath.startsWith("/calendar/v3/") && responseData.includes("/calendar/v3/calendar/v3/")) {
    return endpointPath.replace(/^\/calendar\/v3/, "");
  }
  return null;
}

async function proxyExecuteWithHeuristics(
  composio: Composio,
  request: ProxyExecuteParams
): Promise<ProxyExecuteResponse> {
  let exec = (await composio.tools.proxyExecute(request)) as ProxyExecuteResponse;
  if (exec.status === 404) {
    const maybeFixed = tryFixDuplicatedPrefix(request.endpoint, exec.data);
    if (maybeFixed) {
      exec = (await composio.tools.proxyExecute({
        ...request,
        endpoint: maybeFixed,
      })) as ProxyExecuteResponse;
    }
  }
  return exec;
}

type SharedMemory = {
  pathParamCache: Map<string, string>;
  connectedAccountIdByToolkit: Map<string, string>;
  defaultConnectedAccountId: string | null;
};

async function resolvePathParamValue(
  params: { composio: Composio; connectedAccountId: string; endpoints: EndpointDefinition[] },
  shared: SharedMemory,
  paramName: string,
  consumer: EndpointDefinition
) {
  const cached = shared.pathParamCache.get(paramName);
  if (cached) return cached;

  // Prefer the collection path immediately before the placeholder segment.
  // e.g. /messages/{messageId}/trash -> /messages
  //      /events/{eventId} -> /events
  const parts = consumer.path.split("/").filter(Boolean);
  const placeholder = `{${paramName}}`;
  const idx = parts.indexOf(placeholder);
  const basePath =
    idx > 0 ? `/${parts.slice(0, idx).join("/")}` : consumer.path.replace(/\/+$/, "");

  const listCandidates = params.endpoints.filter(
    (e) => e.method.toUpperCase() === "GET" && (e.path === basePath || basePath.endsWith(e.path))
  );
  const candidate = listCandidates.sort((a, b) => b.path.length - a.path.length)[0];
  if (!candidate) return null;

  const exec = (await params.composio.tools.proxyExecute({
    endpoint: candidate.path,
    method: candidate.method as ProxyExecuteParams["method"],
    connectedAccountId: params.connectedAccountId,
    parameters: buildQueryParams(candidate),
  } as ProxyExecuteParams)) as ProxyExecuteResponse;
  // Apply duplication-prefix heuristic for list calls too.
  // (Some toolkits embed version in `path`, while the proxy also prefixes it.)
  // Re-run through the helper for a retry if needed.
  const execFixed =
    exec.status === 404
      ? await proxyExecuteWithHeuristics(params.composio, {
          endpoint: candidate.path,
          method: candidate.method as ProxyExecuteParams["method"],
          connectedAccountId: params.connectedAccountId,
          parameters: buildQueryParams(candidate),
        })
      : exec;

  if (!(execFixed.status >= 200 && execFixed.status < 300)) return null;

  const keyChoices = [paramName, paramName.replace(/id$/i, ""), "id"].filter(Boolean);
  const found = findFirstPrimitiveByKeys(execFixed.data, keyChoices);
  if (found != null) {
    const str = String(found);
    shared.pathParamCache.set(paramName, str);
    return str;
  }

  // If list returned no usable id, try creating the resource (POST on same basePath) and extract its id.
  const createCandidate = params.endpoints.find(
    (e) => e.method.toUpperCase() === "POST" && (e.path === basePath || basePath.endsWith(e.path))
  );
  if (!createCandidate) return null;

  const body = buildBody(createCandidate);
  const created = await proxyExecuteWithHeuristics(params.composio, {
    endpoint: createCandidate.path,
    method: createCandidate.method as ProxyExecuteParams["method"],
    connectedAccountId: params.connectedAccountId,
    body,
  });

  if (!(created.status >= 200 && created.status < 300)) return null;

  const createdId = findFirstPrimitiveByKeys(created.data, ["id", paramName]);
  if (createdId == null) return null;

  const str = String(createdId);
  shared.pathParamCache.set(paramName, str);
  return str;
}

async function buildExecutableRequest(
  params: { composio: Composio; connectedAccountId: string; endpoints: EndpointDefinition[] },
  shared: SharedMemory,
  def: EndpointDefinition
) {
  let endpointPath = def.path;

  const pathParams = extractPathParams(def.path);
  for (const p of pathParams) {
    const v = await resolvePathParamValue(params, shared, p, def);
    if (v == null) return { ok: false as const, reason: `Unable to resolve path param {${p}}` };
    endpointPath = endpointPath.replaceAll(`{${p}}`, v);
  }

  const method = def.method.toUpperCase() as ProxyExecuteParams["method"];
  const parameters = buildQueryParams(def);
  const body =
    method === "POST" || method === "PUT" || method === "PATCH" ? buildBody(def) : undefined;

  return {
    ok: true as const,
    request: {
      endpoint: endpointPath,
      method,
      connectedAccountId: params.connectedAccountId,
      parameters,
      body,
    } satisfies ProxyExecuteParams,
  };
}

async function validateOneEndpoint(
  params: { composio: Composio; connectedAccountId: string; endpoints: EndpointDefinition[] },
  shared: SharedMemory,
  def: EndpointDefinition
): Promise<EndpointReport> {
  const toolkitSlug = def.tool_slug.split("_")[0]?.toLowerCase?.() ?? "";
  const resolvedConnectedAccountId =
    shared.connectedAccountIdByToolkit.get(toolkitSlug) ??
    shared.defaultConnectedAccountId ??
    params.connectedAccountId;

  const base = {
    tool_slug: def.tool_slug,
    method: def.method,
    path: def.path,
    required_scopes: def.required_scopes,
    available_scopes: [] as string[],
  };

  const built = await buildExecutableRequest(
    { ...params, connectedAccountId: resolvedConnectedAccountId },
    shared,
    def
  );
  if (!built.ok) {
    return {
      ...base,
      status: "error",
      http_status_code: null,
      response_summary: summaryFor("error", null, built.reason),
      response_body: built.reason,
    };
  }

  let exec = (await params.composio.tools.proxyExecute(built.request)) as ProxyExecuteResponse;
  exec = await proxyExecuteWithHeuristics(params.composio, built.request);

  if (
    exec.status === 400 &&
    (built.request.method === "POST" || built.request.method === "PUT" || built.request.method === "PATCH") &&
    !built.request.body &&
    def.parameters.body?.fields?.some((f) => f.required)
  ) {
    const retryBody: Record<string, unknown> = {};
    for (const f of def.parameters.body.fields) {
      if (!f.required) continue;
      retryBody[f.name] = valueFromField(f);
    }
    exec = (await params.composio.tools.proxyExecute({
      ...built.request,
      body: retryBody,
    })) as ProxyExecuteResponse;
  }

  const status = classify(exec.status);
  const hint =
    status === "invalid_endpoint"
      ? "If this endpoint is valid, the definition likely has a wrong method/path."
      : status === "error" && exec.status === 400
        ? "400 often indicates missing/invalid params/body; agent attempted a minimal payload."
        : undefined;

  return {
    ...base,
    status,
    http_status_code: exec.status ?? null,
    response_summary: summaryFor(status, exec.status ?? null, hint),
    response_body: safeResponseBody(exec.data),
  };
}

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const shared: SharedMemory = {
    pathParamCache: new Map(),
    connectedAccountIdByToolkit: new Map(),
    defaultConnectedAccountId: null,
  };

  const work = {
    composio: params.composio,
    connectedAccountId: params.connectedAccountId,
    endpoints: params.endpoints,
  };

  // Runner passes connectedAccountId="candidate" (a user id), but proxyExecute needs a `ca_...` id.
  // Resolve active connected accounts once and reuse for all endpoints.
  if (!params.connectedAccountId.startsWith("ca_")) {
    try {
      const res = await (params.composio as any).connectedAccounts.list({
        user_ids: [params.connectedAccountId],
        statuses: ["ACTIVE"],
      });

      const items: any[] = res?.items ?? [];
      for (const item of items) {
        const slug = item?.toolkit?.slug;
        const id = item?.id;
        if (typeof slug === "string" && typeof id === "string") {
          shared.connectedAccountIdByToolkit.set(slug.toLowerCase(), id);
          if (!shared.defaultConnectedAccountId) shared.defaultConnectedAccountId = id;
        }
      }
    } catch {
      // If listing fails, we'll fall back to whatever connectedAccountId was provided.
    }
  } else {
    shared.defaultConnectedAccountId = params.connectedAccountId;
  }

  const settled = await Promise.allSettled(
    params.endpoints.map((ep) => validateOneEndpoint(work, shared, ep))
  );

  const results: EndpointReport[] = settled.map((s, idx) => {
    if (s.status === "fulfilled") return s.value;
    const def = params.endpoints[idx];
    return {
      tool_slug: def.tool_slug,
      method: def.method,
      path: def.path,
      status: "error",
      http_status_code: null,
      response_summary: summaryFor("error", null, "Unhandled exception while testing endpoint."),
      response_body: safeResponseBody(String(s.reason)),
      required_scopes: def.required_scopes,
      available_scopes: [],
    };
  });

  const summary = {
    valid: results.filter((r) => r.status === "valid").length,
    invalid_endpoint: results.filter((r) => r.status === "invalid_endpoint").length,
    insufficient_scopes: results.filter((r) => r.status === "insufficient_scopes").length,
    error: results.filter((r) => r.status === "error").length,
  };

  return {
    timestamp: nowIso(),
    total_endpoints: params.endpoints.length,
    results,
    summary,
  };
}
