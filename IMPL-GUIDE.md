Below is an implementation guide for WebChat3.0 based on the architecture and the referenced WeCom channel patterns.

**Core Design**
WebChat3.0 should be built as two deployable pieces:

1. `server/`: public Chat Server on port `3100`
   - Browser connects to `/ws`
   - OpenClaw plugin connects to `/plugin`
   - Server only routes messages and tracks connections

2. `plugin/`: OpenClaw Channel Plugin
   - Registers a `webchat` channel
   - Actively connects outbound to Chat Server
   - Converts browser messages into OpenClaw inbound contexts
   - Sends OpenClaw replies back to Chat Server through WebSocket

The important architectural decision is that the plugin dials out to the Chat Server. The Chat Server never calls the plugin directly, so OpenClaw can run behind NAT or on a private machine.

---

## 1. Project Structure

```text
webchat3.0/
├── ARCHITECTURE.md
├── server/
│   ├── package.json
│   ├── server.js
│   ├── public/
│   │   └── index.html
│   └── README.md
└── plugin/
    ├── package.json
    ├── openclaw.plugin.json
    ├── index.js
    └── src/
        ├── channel.js
        ├── ws-client.js
        ├── runtime.js
        ├── const.js
        └── accounts.js
```

`server/` is independently deployable. `plugin/` is installed into OpenClaw with `--link` during development.

---

## 2. Message Protocol

Use one small JSON protocol across both WebSocket paths.

### Plugin -> Chat Server

注册消息（V2：appId + secret 鉴权，替代 pluginId）：

```json
{
  "type": "register",
  "appId": "wch_abc123",
  "secret": "***"
}
```

转发回复（V2：新增 appId 字段）：

```json
{
  "type": "outgoing",
  "appId": "wch_abc123",
  "agentId": "main",
  "userId": "u_123",
  "conversationId": "u_123",
  "content": "你好，我是研发小虾。",
  "messageId": "msg_abc"
}
```

### Chat Server -> Plugin

```json
// 注册成功
{ "type": "registered", "ok": true, "appId": "wch_abc123" }

// 注册失败（appId 不存在或 secret 不匹配）
{ "type": "register_error", "error": "invalid_app" | "invalid_secret" }
```

用户消息：

```json
{
  "type": "incoming",
  "userId": "u_123",
  "appId": "wch_abc123",
  "agentId": "main",
  "conversationId": "u_123",
  "content": "你好",
  "messageId": "browser_1710000000000"
}
```

App 列表（直接展示 appId + name，一个 appId = 一个 Agent）：

```json
{
  "type": "app_list",
  "apps": [
    { "appId": "wch_abc123", "name": "研发小虾" },
    { "appId": "wch_def456", "name": "悟空" }
  ]
}
```

### Browser -> Chat Server

```json
// 注册
{ "type": "register", "userId": "吴涛" }

// 发消息（V2：仅需 appId，不携带 agentId。Server 按 appId 路由到 Plugin，Plugin 通过 bindings 映射到对应 agent）
{
  "type": "message",
  "appId": "wch_abc123",
  "content": "你好"
}
```

### Chat Server -> Browser

```json
// 注册确认
{ "type": "registered", "userId": "u_123" }

// app 列表（V2：每个 app = 一个 Agent，appId 全局唯一）
{
  "type": "app_list",
  "apps": [
    { "appId": "wch_abc123", "name": "研发小虾" },
    { "appId": "wch_def456", "name": "悟空" }
  ]
}

// 回复消息（V2：携带 appId）
{
  "type": "message",
  "from": "agent:main",
  "appId": "wch_abc123",
  "agentId": "main",
  "content": "你好，我是研发小虾。"
}
```

---

## 3. Chat Server

### `server/package.json`

```json
{
  "name": "webchat3-server",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

### `server/server.js`

```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3100);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browsers = new Map();
// userId -> Set<WebSocket>

const browserMeta = new WeakMap();
// ws -> { userId, lastSeen }

const plugins = new Map();
// appId -> { ws, appId, agents, lastSeen }

const pluginMeta = new WeakMap();
// ws -> { appId, lastSeen }

const appRegistry = new Map();
// appId -> { secret, name } — Server 侧预先注册的应用凭证
// 从 apps.json 配置文件加载

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return false;

  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function listApps() {
  const agents = [];

  for (const [appId, entry] of plugins.entries()) {
    for (const agent of entry.agents || []) {
      agents.push({
        appId,
        agentId: agent.agentId,
        name: app.name || agent.agentId
      });
    }
  }

  return agents;
}

function broadcastAgentList() {
  const apps = listApps();

  for (const browserSet of browsers.values()) {
    for (const ws of browserSet) {
      sendJson(ws, { type: "app_list", apps });
    }
  }

  for (const entry of plugins.values()) {
    sendJson(entry.ws, { type: "app_list", agents });
  }
}

function addBrowser(ws, userId) {
  const existing = browsers.get(userId) || new Set();
  existing.add(ws);
  browsers.set(userId, existing);

  browserMeta.set(ws, {
    userId,
    lastSeen: Date.now()
  });
}

function removeBrowser(ws) {
  const meta = browserMeta.get(ws);
  if (!meta?.userId) return;

  const set = browsers.get(meta.userId);
  if (!set) return;

  set.delete(ws);

  if (set.size === 0) {
    browsers.delete(meta.userId);
  }
}

function registerApp(ws, appId, name) {
  const normalizedAgents = Array.isArray(agents)
    ? agents.map((agent) => {
        if (typeof agent === "string") {
          return { agentId: agent, name: agent };
        }

        return {
          agentId: String(agent.agentId),
          name: app.name || String(agent.agentId)
        };
      })
    : [];

  plugins.set(pluginId, {
    ws,
    pluginId,
    agents: normalizedAgents,
    lastSeen: Date.now()
  });

  pluginMeta.set(ws, {
    pluginId,
    lastSeen: Date.now()
  });

  for (const agent of normalizedAgents) {
    appIndex.set(agent.agentId, pluginId);
  }
}

function removePlugin(ws) {
  const meta = pluginMeta.get(ws);
  if (!meta?.pluginId) return;

  const entry = plugins.get(meta.pluginId);
  plugins.delete(meta.pluginId);

  if (entry?.agents) {
    for (const agent of entry.agents) {
      if (appIndex.get(agent.agentId) === meta.pluginId) {
        appIndex.delete(agent.agentId);
      }
    }
  }

  broadcastAgentList();
}

function routeBrowserMessage(ws, message) {
  const meta = browserMeta.get(ws);

  if (!meta?.userId) {
    sendJson(ws, {
      type: "error",
      error: "browser_not_registered"
    });
    return;
  }

  const apps = listApps();
  const agentId = message.agentId || agents[0]?.agentId;

  if (!agentId) {
    sendJson(ws, {
      type: "error",
      error: "no_agent_available"
    });
    return;
  }

  const pluginId = appIndex.get(agentId);
  const plugin = pluginId ? plugins.get(pluginId) : null;

  if (!plugin || plugin.ws.readyState !== plugin.ws.OPEN) {
    sendJson(ws, {
      type: "error",
      error: "agent_unavailable",
      agentId
    });
    return;
  }

  sendJson(plugin.ws, {
    type: "incoming",
    userId: meta.userId,
    agentId,
    conversationId: meta.userId,
    content: String(message.content || ""),
    messageId: message.messageId || `browser_${Date.now()}`
  });
}

function routePluginOutgoing(ws, message) {
  const meta = pluginMeta.get(ws);

  if (!meta?.pluginId) {
    sendJson(ws, {
      type: "error",
      error: "plugin_not_registered"
    });
    return;
  }

  const userId = String(message.userId || message.conversationId || "");
  const browserSet = browsers.get(userId);

  if (!browserSet || browserSet.size === 0) {
    sendJson(ws, {
      type: "delivery_ack",
      ok: false,
      reason: "browser_offline",
      userId
    });
    return;
  }

  for (const browser of browserSet) {
    sendJson(browser, {
      type: "message",
      from: "agent",
      appId: message.appId,
      content: String(message.content || ""),
      messageId: message.messageId || `plugin_${Date.now()}`
    });
  }

  sendJson(ws, {
    type: "delivery_ack",
    ok: true,
    userId
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const file = path.join(__dirname, "public", "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const browserWss = new WebSocketServer({ noServer: true });
const pluginWss = new WebSocketServer({ noServer: true });

browserWss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    const meta = browserMeta.get(ws);
    if (meta) meta.lastSeen = Date.now();
  });

  ws.on("message", (raw) => {
    const message = parseJson(raw);

    if (!message?.type) {
      sendJson(ws, { type: "error", error: "invalid_json" });
      return;
    }

    if (message.type === "register") {
      const userId = String(message.userId || `u_${Date.now()}`);

      addBrowser(ws, userId);

      sendJson(ws, {
        type: "registered",
        userId
      });

      sendJson(ws, {
        type: "app_list",
        agents: listApps()
      });

      return;
    }

    if (message.type === "message") {
      routeBrowserMessage(ws, message);
      return;
    }

    if (message.type === "ping") {
      sendJson(ws, { type: "pong", ts: Date.now() });
      return;
    }

    sendJson(ws, {
      type: "error",
      error: "unknown_type",
      receivedType: message.type
    });
  });

  ws.on("close", () => removeBrowser(ws));
  ws.on("error", () => removeBrowser(ws));
});

pluginWss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    const meta = pluginMeta.get(ws);
    if (meta) meta.lastSeen = Date.now();
  });

  ws.on("message", (raw) => {
    const message = parseJson(raw);

    if (!message?.type) {
      sendJson(ws, { type: "error", error: "invalid_json" });
      return;
    }

    if (message.type === "register") {
      const appId = String(message.appId || "");
      const secret = String(message.secret || "");

      if (!appId) {
        sendJson(ws, { type: "error", error: "missing_app_id" });
        return;
      }

      // 从 appRegistry 验证 appId + secret
      const appEntry = appRegistry.get(appId);
      if (!appEntry) {
        sendJson(ws, { type: "register_error", error: "invalid_app" });
        return;
      }
      if (appEntry.secret !== secret) {
        sendJson(ws, { type: "register_error", error: "invalid_secret" });
        return;
      }

      // 如果已有相同 appId 的连接，关闭旧的
      const existing = plugins.get(appId);
      if (existing?.ws && existing.ws !== ws) {
        try { existing.ws.close(); } catch {}
      }

      registerApp(ws, appId, existingApp.name);

      sendJson(ws, { type: "registered", ok: true, appId });
      broadcastAgentList();
      return;
    }

    if (message.type === "outgoing") {
      routePluginOutgoing(ws, message);
      return;
    }

    if (message.type === "ping") {
      sendJson(ws, { type: "pong", ts: Date.now() });
      return;
    }

    sendJson(ws, {
      type: "error",
      error: "unknown_type",
      receivedType: message.type
    });
  });

  ws.on("close", () => removePlugin(ws));
  ws.on("error", () => removePlugin(ws));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/ws") {
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit("connection", ws, req);
    });
    return;
  }

  if (url.pathname === "/plugin") {
    pluginWss.handleUpgrade(req, socket, head, (ws) => {
      pluginWss.emit("connection", ws, req);
    });
    return;
  }

  socket.destroy();
});

setInterval(() => {
  for (const wss of [browserWss, pluginWss]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[webchat-server] listening on :${PORT}`);
});
```

Key details:

- `browsers`: tracks all browser sockets by `userId`
- `plugins`: tracks active OpenClaw plugin sockets by `pluginId`
- `appIndex`: routes `appId -> pluginData`（不再使用 agentId 路由）
- `/ws`: browser WebSocket endpoint
- `/plugin`: OpenClaw plugin WebSocket endpoint
- heartbeat uses WebSocket ping/pong every 30 seconds
- server does not run OpenClaw logic; it only routes frames

---

## 4. Channel Plugin Manifest

### `plugin/openclaw.plugin.json`

```json
{
  "id": "webchat-openclaw-plugin",
  "kind": "channel",
  "channels": ["webchat"],
  "name": "WebChat",
  "description": "Browser-based WebChat channel for OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "channelConfigs": {
    "webchat": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled": {
            "type": "boolean"
          },
          "serverUrl": {
            "type": "string",
            "description": "Chat Server WebSocket URL, for example wss://webchat.zeaho.site/plugin"
          },
          "accounts": {
            "type": "object",
            "description": "Multiple account bindings (one appId per Agent)",
            "additionalProperties": {
              "type": "object",
              "properties": {
                "appId": { "type": "string" },
                "secret": { "type": "string" }
              },
              "required": ["appId", "secret"]
            }
          }
          }
        }
      },
      "uiHints": {
        "serverUrl": {
          "label": "Chat Server URL"
        }
      }
    }
  }
}
```

### `plugin/package.json`

```json
{
  "name": "@local/webchat-openclaw-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "files": [
    "index.js",
    "src",
    "openclaw.plugin.json"
  ],
  "dependencies": {
    "ws": "^8.18.0"
  },
  "peerDependencies": {
    "openclaw": ">=2026.3.28"
  },
  "peerDependenciesMeta": {
    "openclaw": {
      "optional": true
    }
  },
  "openclaw": {
    "extensions": ["./index.js"],
    "channel": {
      "id": "webchat",
      "label": "WebChat",
      "selectionLabel": "WebChat",
      "docsPath": "/channels/webchat",
      "docsLabel": "webchat",
      "blurb": "Browser chat channel for OpenClaw"
    },
    "install": {
      "localPath": "plugin",
      "defaultChoice": "local"
    }
  }
}
```

---

## 5. Runtime Store

This follows the same pattern as the WeCom plugin.

### `plugin/src/runtime.js`

```js
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setWebChatRuntime,
  getRuntime: getWebChatRuntime
} = createPluginRuntimeStore("WebChat runtime not initialized");

export {
  setWebChatRuntime,
  getWebChatRuntime
};
```

---

## 6. Constants

### `plugin/src/const.js`

```js
// DEFAULT_ACCOUNT_ID 从 SDK 导入：import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export const CHANNEL_ID = "webchat";
export const DEFAULT_SERVER_URL = "ws://localhost:3100/plugin";
export const TEXT_CHUNK_LIMIT = 3500;
```

---

## 7. Account Resolution

### `plugin/src/accounts.js`

```js
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { CHANNEL_ID, DEFAULT_SERVER_URL } from "./const.js";

/**
 * 解析 webchat channel 配置（保持兼容性）
 * 新配置格式：channels.webchat.accounts.{accountId}
 * 旧配置格式：channels.webchat.serverUrl（兼容过渡，不含 agents）
 */
/** 提取 channels.webchat 段（对标 feishu 的 getLarkConfig） */
export function getWebChatConfig(cfg) {
  return cfg.channels?.webchat || {};
}

/** 剥离 accounts 键，返回顶层默认值（对标 feishu 的 baseConfig） */
function baseConfig(section) {
  const { accounts: _ignored, ...rest } = section;
  return rest;
}

/** 深层合并：账号级覆盖顶层，对象字段做浅合并（对标 feishu 的 mergeAccountConfig） */
function mergeAccountConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined) continue;
    const baseVal = base[key];
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      result[key] = { ...baseVal, ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 列出所有 accountId（对标 feishu 的 listAccountIds）
 */
export function listWebChatAccountIds(cfg) {
  const section = getWebChatConfig(cfg);
  const accounts = section.accounts || {};

  if (accounts && typeof accounts === 'object' && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }

  // 兼容旧配置：没有 accounts 时使用默认 ID
  return [DEFAULT_ACCOUNT_ID];
}

/**
 * 返回默认 accountId
 */
export function getDefaultWebChatAccountId(cfg) {
  const ids = listWebChatAccountIds(cfg);
  return ids[0] || DEFAULT_ACCOUNT_ID;
}

/**
 * 解析指定 account 的完整配置（对标 feishu 的 resolveAccount）
 * 注意：一个 account 对应一个 Agent，appId 全局唯一，通过 bindings 绑定到 agentId
 * 
 * 新格式示例：
 * "webchat": {
 *   "enabled": true,
 *   "accounts": {
 *     "my-instance": {
 *       "appId": "wch_abc123",
 *       "secret": "sk-xxx",
 *     }
 *   }
 * }
 */
export function getWebChatAccount(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const section = getWebChatConfig(cfg);
  if (!section) {
    return { accountId, enabled: false, configured: false, config: {} };
  }

  const base = baseConfig(section);
  const accountMap = section.accounts || {};
  const accountOverride = accountMap[accountId];
  const merged = accountOverride ? mergeAccountConfig(base, accountOverride) : { ...base };

  const appId = merged.appId || '';
  const secret = merged.secret || '';
  const configured = !!(appId && secret);

  return {
    accountId,
    enabled: merged.enabled !== false,
    configured,
    appId,
    secret,
    serverUrl: merged.serverUrl || process.env.WEBCHAT_SERVER_URL || DEFAULT_SERVER_URL,
    allowFrom: merged.allowFrom || ["*"],
    dmPolicy: merged.dmPolicy || "open",
    config: merged,
  };
}

/** 抽取凭据（对标 feishu 的 getLarkCredentials） */
export function getWebChatCredentials(cfg) {
  if (!cfg) return null;
  const { appId, secret } = cfg;
  if (!appId || !secret) return null;
  return { appId, secret };
}

export function isConfigured(account) {
  return account.configured;
}
```

---

## 8. Plugin Entry

### `plugin/index.js`

```js
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { webchatPlugin } from "./src/channel.js";
import { setWebChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "webchat-openclaw-plugin",
  name: "WebChat",
  description: "Browser WebChat channel for OpenClaw",
  configSchema: emptyPluginConfigSchema()

  register(api) {
    setWebChatRuntime(api.runtime);

    api.registerChannel({
      plugin: webchatPlugin
    });
  }
};

export default plugin;
```

This mirrors the referenced WeCom plugin pattern:

```js
setRuntime(api.runtime);
api.registerChannel({ plugin });
```

---

## 9. Channel Definition

### `plugin/src/channel.js`

```js
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import {
  listWebChatAccountIds,
  resolveWebChatAccount,
  getDefaultWebChatAccountId
} from "./accounts.js";
import {
  startWebChatWsClient,
  stopWebChatWsClient,
  sendOutgoingMessage
} from "./ws-client.js";
import { getWebChatRuntime } from "./runtime.js";

const meta = {
  id: CHANNEL_ID,
  label: "WebChat",
  selectionLabel: "WebChat",
  detailLabel: "Browser WebChat",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb: "Browser-based channel for OpenClaw",
  systemImage: "message.fill"
};

export const webchatPlugin = {
  id: CHANNEL_ID

  meta: {
    ...meta,
    quickstartAllowFrom: true
  }

  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true
  }

  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`]
  }

  config: {
    listAccountIds: (cfg) => listWebChatAccountIds(cfg)

    resolveAccount: (cfg, accountId) => {
      return getWebChatAccount(cfg, accountId || DEFAULT_ACCOUNT_ID);
    }

    defaultAccountId: (cfg) => {
      return getDefaultWebChatAccountId(cfg);
    }

    isConfigured: (account) => {
      return isConfigured(account);
    }

    describeAccount: (account) => {
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.serverUrl),
        serverUrl: account.serverUrl,
        appId: account.appId
      };
    }

    resolveAllowFrom: ({ account }) => {
      return account.allowFrom || ["*"];
    }

    formatAllowFrom: ({ allowFrom }) => {
      return allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }
  }

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.dmPolicy || "open",
        allowFrom: account.allowFrom || ["*"],
        approveHint: "Ask the operator to add your WebChat user id to allowFrom."
      };
    }
  }

  messaging: {
    normalizeTarget: (target) => {
      const trimmed = String(target || "").trim();
      return trimmed || undefined;
    }

    targetResolver: {
      looksLikeId: (id) => Boolean(String(id || "").trim()),
      hint: "<webchatUserId>"
    }
  }

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => []
  }

  outbound: {
    deliveryMode: "gateway"

    chunker: (text, limit) => {
      return getWebChatRuntime().channel.text.chunkMarkdownText(text, limit);
    }

    textChunkLimit: TEXT_CHUNK_LIMIT

    async sendText(params) {
      return sendOutgoingMessage({
        to: params.to,
        text: params.text || "",
        accountId: params.accountId || DEFAULT_ACCOUNT_ID,
        agentId: params.agentId,
        cfg: params.cfg
      });
    }
  }

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null
    }

    collectStatusIssues(accounts) {
      return accounts.flatMap((entry) => {
        if (entry.enabled === false) return [];

        if (!entry.configured) {
          return [
            {
              channel: CHANNEL_ID,
              accountId: entry.accountId || DEFAULT_ACCOUNT_ID,
              kind: "config",
              message: "WebChat serverUrl is not configured",
              fix: "Set channels.webchat.serverUrl to ws://host:3100/plugin"
            }
          ];
        }

        return [];
      });
    }

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null
    })

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.serverUrl),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null
    })
  }

  gateway: {
    async startAccount(ctx) {
      const account = resolveWebChatAccount(ctx.cfg, ctx.accountId);

      ctx.log?.info(
        `starting webchat[${account.accountId}] server=${account.serverUrl}`
      );

      return startWebChatWsClient({
        account,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus
      });
    }

    async logoutAccount() {
      await stopWebChatWsClient(DEFAULT_ACCOUNT_ID);

      return {
        cleared: false,
        envToken: false,
        loggedOut: true
      };
    }
  }
};
```

The channel owns:

- account resolution
- channel metadata
- DM security
- outbound delivery
- gateway lifecycle
- WebSocket startup and shutdown

---

## 10. WebSocket Client

### `plugin/src/ws-client.js`

```js
import WebSocket from "ws";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./const.js";
import { getWebChatRuntime } from "./runtime.js";
import { resolveWebChatAccount } from "./accounts.js";

const clients = new Map();
// accountId -> client state

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function stripChannelPrefix(to) {
  return String(to || "").replace(/^webchat:/i, "");
}

function buildInboundContext({ message, account, cfg }) {
  const core = getWebChatRuntime();

  const userId = String(message.userId);
  const conversationId = String(message.conversationId || userId);
  const content = String(message.content || "");
  const agentId = account.agentId || "default";  // Plugin 通过 bindings 自己的配置确定 agentId

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: conversationId
    },
    agentId
  });

  // Override sessionKey to isolate by (user, agent)
  // 同一 appId 下，不同 userId → 不同 session，对话历史互不干扰
  route.sessionKey = `${CHANNEL_ID}:${userId}:${message.appId}`;  // appId 唯一 = 一个 Agent

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: content,
    RawBody: content,
    CommandBody: content

    MessageSid: message.messageId || `webchat_${Date.now()}`

    From: `${CHANNEL_ID}:${userId}`,
    To: `${CHANNEL_ID}:${conversationId}`,
    SenderId: userId

    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct"

    Timestamp: Date.now(),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${conversationId}`

    CommandAuthorized: true

    WebChatMessage: message,
    AgentId: agentId  // Plugin 通过 bindings 将 appId 映射到 agentId
  });

  return {
    core,
    route,
    storePath,
    ctxPayload,
    userId,
    conversationId,
    agentId
  };
}

async function dispatchIncoming({ message, account, cfg, runtime }) {
  const {
    core,
    route,
    storePath,
    ctxPayload,
    userId,
    conversationId,
    agentId
  } = buildInboundContext({ message, account, cfg });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey || route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey || route.sessionKey,
      channel: CHANNEL_ID,
      to: `${CHANNEL_ID}:${conversationId}`,
      accountId: route.accountId
    },
    onRecordError: (err) => {
      runtime.error?.(`[webchat] failed updating session meta: ${String(err)}`);
    }
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    replyOptions: {},
    dispatcherOptions: {
      onReplyStart: async () => {
        runtime.log?.(`[webchat] reply started user=${userId} agent=${agentId}`);
      }

      deliver: async (payload, info) => {
        runtime.log?.(
          `[openclaw -> webchat] kind=${info.kind} payload=${JSON.stringify(payload)}`
        );

        const text = payload.text || "";
        if (!text) return;

        await sendOutgoingMessage({
          to: `${CHANNEL_ID}:${userId}`,
          text,
          accountId: account.accountId,
          cfg
        });
      }

      onError: (err, info) => {
        runtime.error?.(
          `[webchat] ${info.kind} reply failed: ${String(err)}`
        );
      }
    }
  });
}

function connectWithReconnect(state) {
  const {
    account,
    cfg,
    runtime,
    abortSignal,
    setStatus
  } = state;

  if (abortSignal?.aborted) return;

  runtime.log?.(`[webchat] connecting to ${account.serverUrl}`);

  const ws = new WebSocket(account.serverUrl);
  state.ws = ws;
  state.connected = false;

  let heartbeatTimer = null;

  ws.on("open", () => {
    state.connected = true;
    state.reconnectAttempt = 0;

    runtime.log?.(`[webchat] connected account=${account.accountId}`);

    setStatus?.({
      accountId: account.accountId,
      running: true,
      lastStartAt: Date.now(),
      lastError: null
    });

    sendJson(ws, {
      type: "register",
      appId: account.appId,
      secret: account.secret,
      // 一个 appId = 一个 Agent，无 agents
    });

    heartbeatTimer = setInterval(() => {
      sendJson(ws, {
        type: "ping",
        ts: Date.now()
      });
    }, 25_000);
  });

  ws.on("message", async (raw) => {
    const message = parseJson(raw);

    if (!message?.type) {
      runtime.error?.("[webchat] invalid message from server");
      return;
    }

    if (message.type === "registered") {
      runtime.log?.("[webchat] plugin registration accepted");
      return;
    }

    if (message.type === "pong") {
      state.lastPongAt = Date.now();
      return;
    }

    if (message.type === "app_list") {
      runtime.log?.(`[webchat] app_list ${JSON.stringify(message.agents || [])}`);
      return;
    }

    if (message.type === "incoming") {
      try {
        await dispatchIncoming({
          message,
          account,
          cfg,
          runtime
        });
      } catch (err) {
        runtime.error?.(`[webchat] failed dispatching inbound: ${String(err)}`);
      }

      return;
    }

    if (message.type === "delivery_ack") {
      runtime.log?.(`[webchat] delivery_ack ${JSON.stringify(message)}`);
      return;
    }

    if (message.type === "error") {
      runtime.error?.(`[webchat] server error ${JSON.stringify(message)}`);
      return;
    }

    runtime.log?.(`[webchat] ignored message type=${message.type}`);
  });

  ws.on("close", () => {
    state.connected = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    setStatus?.({
      accountId: account.accountId,
      running: false,
      lastStopAt: Date.now()
    });

    scheduleReconnect(state);
  });

  ws.on("error", (err) => {
    runtime.error?.(`[webchat] websocket error: ${String(err.message || err)}`);

    setStatus?.({
      accountId: account.accountId,
      running: false,
      lastError: String(err.message || err)
    });
  });
}

function scheduleReconnect(state) {
  if (state.abortSignal?.aborted) return;

  state.reconnectAttempt = (state.reconnectAttempt || 0) + 1;

  const delay = Math.min(
    30_000,
    1_000 * 2 ** Math.min(state.reconnectAttempt, 5)
  );

  state.runtime.log?.(
    `[webchat] reconnecting in ${delay}ms attempt=${state.reconnectAttempt}`
  );

  state.reconnectTimer = setTimeout(() => {
    connectWithReconnect(state);
  }, delay);
}

export async function startWebChatWsClient({
  account,
  cfg,
  runtime,
  abortSignal,
  setStatus
}) {
  const state = {
    account,
    cfg,
    runtime,
    abortSignal,
    setStatus,
    ws: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    lastPongAt: null
  };

  clients.set(account.accountId, state);

  if (abortSignal) {
    abortSignal.addEventListener(
      "abort",
      async () => {
        await stopWebChatWsClient(account.accountId);
      },
      { once: true }
    );
  }

  connectWithReconnect(state);

  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function stopWebChatWsClient(accountId = DEFAULT_ACCOUNT_ID) {
  const state = clients.get(accountId);
  if (!state) return;

  clients.delete(accountId);

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      state.ws.terminate?.();
    }
  }
}

export async function sendOutgoingMessage({
  to,
  text,
  accountId = DEFAULT_ACCOUNT_ID,
  agentId,
  cfg
}) {
  let state = clients.get(accountId);

  if (!state && cfg) {
    const account = getWebChatAccount(cfg, accountId);
    state = clients.get(account.accountId);
  }

  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`WebChat WebSocket is not connected for account ${accountId}`);
  }

  const userId = stripChannelPrefix(to);

  const messageId = `webchat_out_${Date.now()}`;

  sendJson(state.ws, {
    type: "outgoing",
    appId: state.account.appId,
    agentId: agentId,  // 通过 bindings 映射到 agentId
    userId,
    conversationId: userId,
    content: text,
    messageId
  });

  return {
    channel: CHANNEL_ID,
    messageId,
    chatId: userId
  };
}
```

---

## 11. Inbound Dispatch Flow

The important flow is:

```text
Chat Server
  -> plugin ws-client receives { type: "incoming", appId, userId, content } (无 agentId)
  -> Plugin 查 bindings 映射 appId → agentId
  -> api.runtime.channel.reply.finalizeInboundContext(...)
  -> api.runtime.channel.session.recordInboundSession(...)
  -> api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)
  -> dispatcher deliver callback streams reply chunks
  -> ws-client sends { type: "outgoing", appId, userId, content } (无 agentId)
```

The essential dispatch sequence is this:

```js
const ctxPayload = core.channel.reply.finalizeInboundContext({
  Body: content,
  RawBody: content,
  CommandBody: content,
  MessageSid: message.messageId,
  From: `webchat:${userId}`,
  To: `webchat:${conversationId}`,
  SenderId: userId,
  SessionKey: route.sessionKey,
  AccountId: route.accountId,
  ChatType: "direct",
  ConversationLabel: `user:${userId}`,
  Timestamp: Date.now(),
  Provider: "webchat",
  Surface: "webchat",
  OriginatingChannel: "webchat",
  OriginatingTo: `webchat:${conversationId}`,
  CommandAuthorized: true
});

await core.channel.session.recordInboundSession({
  storePath,
  sessionKey: ctxPayload.SessionKey || route.sessionKey,
  ctx: ctxPayload,
  updateLastRoute: {
    sessionKey: route.mainSessionKey || route.sessionKey,
    channel: "webchat",
    to: `webchat:${conversationId}`,
    accountId: route.accountId
  }
});

await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
  ctx: ctxPayload,
  cfg,
  dispatcherOptions: {
    deliver: async (payload) => {
      if (!payload.text) return;

      await sendOutgoingMessage({
        to: `webchat:${userId}`,
        text: payload.text,
        accountId: account.accountId,
        agentId
      });
    }
  }
});
```

This is the WebChat version of the WeCom monitor pattern.

---

## 12. Outbound Flow

The outbound flow is the reverse path:

```text
OpenClaw Core
  -> channel outbound.send / outbound.sendText
  -> plugin ws-client sendOutgoingMessage(...)
  -> Chat Server receives { type: "outgoing" }
  -> Chat Server looks up browser by userId
  -> Browser receives { type: "message" }
```

The channel outbound adapter should only translate OpenClaw’s target into a WebChat `userId` and send the frame:

```js
outbound: {
  deliveryMode: "gateway"

  async sendText({ to, text, accountId, cfg }) {
    return sendOutgoingMessage({
      to,
      text,
      accountId,
      cfg
    });
  }
}
```

A typical target is:

```text
webchat:u_123
```

The outgoing frame sent to Chat Server is:

```js
{
  type: "outgoing",
  pluginId: "webchat-openclaw-plugin",
  agentId: "nezha",
  userId: "u_123",
  conversationId: "u_123",
  content: "reply text",
  messageId: "webchat_out_1710000000000"
}
```

---

## 13. Browser Client

A minimal browser can connect like this:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WebChat3.0</title>
  </head>
  <body>
    <select id="apps"></select>
    <div id="messages"></div>
    <input id="input" placeholder="Type a message" />
    <button id="send">Send</button>

    <script>
      const userId = localStorage.userId || `u_${crypto.randomUUID()}`;
      localStorage.userId = userId;

      const wsUrl =
        location.protocol === "https:"
          ? `wss://${location.host}/ws`
          : `ws://${location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      const apps = document.querySelector("#apps");
      const messages = document.querySelector("#messages");
      const input = document.querySelector("#input");

      function append(text) {
        const div = document.createElement("div");
        div.textContent = text;
        messages.appendChild(div);
      }

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "register",
            userId,
            // userName defaults to userId
          })
        );
      });

      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "app_list") {
          apps.innerHTML = "";
          for (const app of message.apps || []) {
            const option = document.createElement("option");
            option.value = app.appId;  // appId 唯一标识一个 Agent
            option.textContent = app.name;  // 展示给用户
            apps.appendChild(option);
          }
          return;
        }

        if (message.type === "message") {
          append(`${message.from}: ${message.content}`);
        }
      });

      document.querySelector("#send").addEventListener("click", () => {
        const content = input.value.trim();
        if (!content) return;

        append(`me: ${content}`);

        ws.send(
          JSON.stringify({
            type: "message",
            appId: apps.value,
            content
          })
        );

        input.value = "";
      });
    </script>
  </body>
</html>
```

---

## 14. Local Development

### Start Chat Server

```bash
cd server
npm install
node server.js
```

Server runs at:

```text
http://localhost:3100
ws://localhost:3100/ws
ws://localhost:3100/plugin
```

### Configure OpenClaw

Example `openclaw.json` channel config:

```json
{
  "channels": {
    "webchat": {
      "enabled": true,
      "serverUrl": "wss://webchat.zeaho.site/plugin",
      "accounts": {
        "dev-main":   { "appId": "wch_abc123", "secret": "***" },
        "dev-helper": { "appId": "wch_def456", "secret": "***" },
        "cloud-main": { "appId": "wch_789ghi", "secret": "***" }
      }
    }
  }

  "bindings": [
    { "agentId": "main",   "match": { "channel": "webchat", "accountId": "dev-main" } },
    { "agentId": "helper", "match": { "channel": "webchat", "accountId": "dev-helper" } },
    { "agentId": "main",   "match": { "channel": "webchat", "accountId": "cloud-main" } }
  ]
}
```

### Install Plugin with Link

Exact CLI names can vary by OpenClaw version, but the intended local flow is:

```bash
cd plugin
npm install

openclaw plugins install --link "$PWD"
```

Then inspect:

```bash
openclaw plugins inspect webchat-openclaw-plugin --runtime --json
openclaw channels status webchat
```

Restart OpenClaw after linking if your runtime does not hot-load linked plugins.

---

## 15. Caddy Reverse Proxy

For production, expose the Chat Server with HTTPS and WebSocket upgrade support.

### `Caddyfile`

```caddyfile
chat.example.com {
  encode gzip

  reverse_proxy 127.0.0.1:3100 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }
}
```

Browser URL:

```text
https://chat.example.com
wss://chat.example.com/ws
```

Plugin config:

```json
{
  "channels": {
    "webchat": {
      "enabled": true,
      "serverUrl": "wss://webchat.zeaho.site/plugin",
      "accounts": {
        "dev-main": { "appId": "wch_abc123", "secret": "***" },
        "dev-helper": { "appId": "wch_def456", "secret": "***" }
      }
    }
  },
  "bindings": [
    { "agentId": "main", "match": { "channel": "webchat", "accountId": "dev-main" } },
    { "agentId": "helper", "match": { "channel": "webchat", "accountId": "dev-helper" } }
  ]
}
```

Run server behind Caddy:

```bash
cd server
PORT=3100 node server.js
```

For systemd:

```ini
[Unit]
Description=WebChat3 Chat Server
After=network.target

[Service]
WorkingDirectory=/opt/webchat3/server
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3100
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 16. Production Notes

Use `wss://` in production. Keep `ws://` only for local development.

Add authentication to `/plugin` before exposing publicly. The simplest production extension is a shared secret:

```json
{
  "type": "register",
  "appId": "wch_abc123",
  "secret": "***"
}
```

Then validate `appId` + `secret` in `server.js` against `apps.json` before accepting plugin registration.

Add browser identity verification if the browser UI is public. Without auth, any browser can claim any `userId`.

Keep Chat Server stateless if possible. For multiple Chat Server instances, move connection routing behind sticky sessions or use Redis pub/sub for cross-instance delivery.

For offline support, add an `offlineMessages` store keyed by `userId`, then flush queued replies when the browser reconnects.

The minimal viable production version is:

- one Chat Server instance
- Caddy HTTPS
- plugin shared secret
- browser login or signed user token
- heartbeat cleanup
- structured logs for register, incoming, outgoing, disconnect, reconnect
- OpenClaw channel status reporting through `gateway.startAccount` / `setStatus`