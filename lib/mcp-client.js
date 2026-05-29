// MCP client for the org's ClaudeConnectMCP server.
// Auth: Salesforce OAuth Client Credentials → bearer token in memory.
// Transport: StreamableHTTPClientTransport over MCP_SERVER_URL.

let ClientCtor, TransportCtor;

async function loadSdk() {
  if (ClientCtor && TransportCtor) return;
  const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
  const transportMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  ClientCtor = clientMod.Client;
  TransportCtor = transportMod.StreamableHTTPClientTransport;
}

const TOKEN_TTL_MS = 25 * 60 * 1000; // ~25 min, conservative

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function fetchToken() {
  const url = process.env.SF_TOKEN_URL;
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  if (!url || !clientId || !clientSecret) {
    throw new Error('Missing SF_TOKEN_URL / SF_CLIENT_ID / SF_CLIENT_SECRET');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`SF token endpoint returned ${res.status}: ${txt}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('SF token response missing access_token');
  return json.access_token;
}

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;
  cachedToken = await fetchToken();
  cachedTokenExpiresAt = now + TOKEN_TTL_MS;
  return cachedToken;
}

function clearToken() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
}

let client = null;
let connectPromise = null;

async function connect() {
  if (client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    await loadSdk();
    const serverUrl = process.env.MCP_SERVER_URL;
    if (!serverUrl) throw new Error('Missing MCP_SERVER_URL');

    const token = await getToken();
    const transport = new TransportCtor(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    const c = new ClientCtor(
      { name: 'field-seller-app', version: '0.1.0' },
      { capabilities: {} },
    );
    await c.connect(transport);
    client = c;
    return c;
  })();

  try {
    return await connectPromise;
  } catch (err) {
    connectPromise = null;
    throw err;
  }
}

async function reconnect() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  client = null;
  connectPromise = null;
  clearToken();
  return connect();
}

function isAuthError(err) {
  const msg = String(err?.message || '');
  return /401|unauthor|invalid[_ ]?token|expired/i.test(msg);
}

async function listTools() {
  const c = await connect();
  try {
    const res = await c.listTools();
    return res.tools || [];
  } catch (err) {
    if (!isAuthError(err)) throw err;
    const c2 = await reconnect();
    const res = await c2.listTools();
    return res.tools || [];
  }
}

async function callTool(name, args) {
  const c = await connect();
  let res;
  try {
    res = await c.callTool({ name, arguments: args });
  } catch (err) {
    if (!isAuthError(err)) throw err;
    const c2 = await reconnect();
    res = await c2.callTool({ name, arguments: args });
  }
  if (res.isError) {
    const msg = (res.content || [])
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n') || 'MCP tool returned isError';
    throw new Error(`MCP tool ${name} failed: ${msg}`);
  }
  return parseToolResult(res);
}

// Most ClaudeConnectMCP tools return JSON in a text content block.
// Try to parse; fall back to raw text or the structured field.
function parseToolResult(res) {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const textParts = (res.content || []).filter(p => p.type === 'text').map(p => p.text);
  const joined = textParts.join('\n').trim();
  if (!joined) return res.content || null;
  try { return JSON.parse(joined); } catch { return joined; }
}

// Translate MCP tool defs → Anthropic SDK tool defs.
// Anthropic accepts standard JSON Schema for input_schema; we strip $schema/$id
// and ensure type:object with properties present.
function toAnthropicTool(mcpTool) {
  const schema = mcpTool.inputSchema || { type: 'object', properties: {} };
  const cleaned = sanitizeSchema(schema);
  if (cleaned.type !== 'object') {
    return { name: mcpTool.name, description: mcpTool.description || '', input_schema: { type: 'object', properties: {} } };
  }
  if (!cleaned.properties) cleaned.properties = {};
  return {
    name: mcpTool.name,
    description: mcpTool.description || '',
    input_schema: cleaned,
  };
}

function sanitizeSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === '$id' || k === '$ref') continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

async function shutdown() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  client = null;
  connectPromise = null;
}

module.exports = {
  connect,
  listTools,
  callTool,
  toAnthropicTool,
  shutdown,
};
