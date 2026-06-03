Below is an implementation guide for WebChat3.0 based on the architecture and the referenced WeCom channel patterns.

**Core Design**
WebChat3.0 should be built as two deployable pieces:

1. `server/`: public Chat Server on port `3100`
   - Browser connects to `/ws`
   - OpenClaw plugin connects to `/plugin`
   - Server only routes messages and tracks connections

2. `plugin/`: OpenClaw Channel Plugin
   - Registers a `openclaw-webchat` channel
   - Actively connects outbound to Chat Server
   - Converts browser messages into OpenClaw inbound contexts
   - Sends OpenClaw replies back to Chat Server through WebSocket

The important architectural decision is that the plugin dials out to the Chat Server. The Chat Server never calls the plugin directly, so OpenClaw can run behind NAT or on a private machine.

---

## 1. Project Structure

```text
webchat3.0/
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   └── IMPL-GUIDE.md
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

注册消息（appId + secret 鉴权）：

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

// 注册失败（appId 不存在、已禁用或 secret 不匹配）
{ "type": "register_error", "error": "invalid_secret" }
```

用户消息：

```json
{
  "type": "incoming",
  "userId": "u_123",
  "appId": "wch_abc123",
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

History payload（Server 按 `(userId, appId)` 返回最近消息；消息中不携带 `agentId`）：

```json
{
  "type": "history",
  "messages": {
    "wch_abc123": [
      {
        "from": "user",
        "appId": "wch_abc123",
        "content": "你好",
        "messageId": "browser_1710000000000",
        "timestamp": 1710000000000
      }
    ]
  }
}
```

### Browser -> Chat Server

```json
// 注册
{ "type": "register", "userId": "吴涛" }

// 发消息（V2：仅需 appId，不携带 agentId。Server 按 appId 路由到 Plugin，Plugin 根据连接对应的 accountId 通过 bindings 映射到对应 agent）
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
  "from": "agent",
  "appId": "wch_abc123",
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
    "bcryptjs": "^2.4.3",
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
import bcrypt from "bcryptjs";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3100);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browsers = new Map();
// userId -> Set<WebSocket>

const browserMeta = new WeakMap();
// ws -> { userId, lastSeen }

const plugins = new Map();
// appId -> { ws, appId, name, connectedAt, lastSeen }

const pluginMeta = new WeakMap();
// ws -> { appId, lastSeen }

const appRegistry = new Map();
// appId -> { secretHash, name, enabled } — 从 apps.json 加载的注册表 apps

const messageHistory = new Map();
// JSON.stringify([userId, appId]) -> [{ from, appId, content, messageId, timestamp }]

const HISTORY_LIMIT = 100;

function loadAppRegistry() {
  const file = path.join(__dirname, "apps.json");
  if (!fs.existsSync(file)) return;

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  appRegistry.clear();

  for (const [appId, app] of Object.entries(data.apps || {})) {
    appRegistry.set(appId, {
      appId,
      name: app.name || appId,
      secretHash: app.secretHash,
      enabled: app.enabled !== false
    });
  }
}

loadAppRegistry();

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;

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
  const apps = [];

  for (const [appId, entry] of plugins.entries()) {
    apps.push({
      appId,
      name: entry.name || appId
    });
  }

  return apps;
}

function broadcastAppList() {
  const apps = listApps();

  for (const browserSet of browsers.values()) {
    for (const ws of browserSet) {
      sendJson(ws, { type: "app_list", apps });
    }
  }

  for (const entry of plugins.values()) {
    sendJson(entry.ws, { type: "app_list", apps });
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
  plugins.set(appId, {
    ws,
    appId,
    name,
    connectedAt: Date.now(),
    lastSeen: Date.now()
  });

  pluginMeta.set(ws, {
    appId,
    lastSeen: Date.now()
  });
}

function removePlugin(ws) {
  const meta = pluginMeta.get(ws);
  if (!meta?.appId) return;

  const entry = plugins.get(meta.appId);
  if (entry?.ws === ws) {
    plugins.delete(meta.appId);
  }

  broadcastAppList();
}

function historyKey(userId, appId) {
  return JSON.stringify([userId, appId]);
}

function appendHistory({ userId, appId, from, content, messageId }) {
  const key = historyKey(userId, appId);
  const list = messageHistory.get(key) || [];

  list.push({
    from,
    appId,
    content,
    messageId,
    timestamp: Date.now()
  });

  if (list.length > HISTORY_LIMIT) {
    list.splice(0, list.length - HISTORY_LIMIT);
  }

  messageHistory.set(key, list);
}

function getHistoryForUser(userId) {
  const messages = {};

  for (const [key, list] of messageHistory.entries()) {
    const [historyUserId, appId] = JSON.parse(key);
    if (historyUserId !== userId) continue;
    messages[appId] = list;
  }

  return messages;
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

  const appId = String(message.appId || "");

  if (!appId) {
    sendJson(ws, {
      type: "error",
      error: "missing_app_id"
    });
    return;
  }

  const plugin = plugins.get(appId);

  if (!plugin || plugin.ws.readyState !== WebSocket.OPEN) {
    sendJson(ws, {
      type: "error",
      error: "app_unavailable",
      appId
    });
    return;
  }

  const messageId = message.messageId || `browser_${Date.now()}`;
  const content = String(message.content || "");

  appendHistory({
    userId: meta.userId,
    appId,
    from: "user",
    content,
    messageId
  });

  sendJson(plugin.ws, {
    type: "incoming",
    appId,
    userId: meta.userId,
    conversationId: meta.userId,
    content,
    messageId
  });
}

function routePluginOutgoing(ws, message) {
  const meta = pluginMeta.get(ws);

  if (!meta?.appId) {
    sendJson(ws, {
      type: "error",
      error: "plugin_not_registered"
    });
    return;
  }

  if (String(message.appId || "") !== meta.appId) {
    sendJson(ws, {
      type: "error",
      error: "app_id_mismatch",
      expectedAppId: meta.appId
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

  const content = String(message.content || "");
  const messageId = message.messageId || `plugin_${Date.now()}`;

  appendHistory({
    userId,
    appId: meta.appId,
    from: "agent",
    content,
    messageId
  });

  for (const browser of browserSet) {
    sendJson(browser, {
      type: "message",
      from: "agent",
      appId: meta.appId,
      content,
      messageId
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
        apps: listApps()
      });

      sendJson(ws, {
        type: "history",
        messages: getHistoryForUser(userId)
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
        ws.close();
        return;
      }
      if (!appEntry.enabled) {
        sendJson(ws, { type: "register_error", error: "app_disabled" });
        ws.close();
        return;
      }

      if (!appEntry.secretHash || !bcrypt.compareSync(secret, appEntry.secretHash)) {
        sendJson(ws, { type: "register_error", error: "invalid_secret" });
        ws.close();
        return;
      }

      // 如果已有相同 appId 的连接，关闭旧的
      const existing = plugins.get(appId);
      if (existing?.ws && existing.ws !== ws) {
        try { existing.ws.close(); } catch {}
      }

      registerApp(ws, appId, appEntry.name);

      sendJson(ws, { type: "registered", ok: true, appId });
      broadcastAppList();
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
- `plugins`: `Map<appId, { ws, appId, name, connectedAt }>` tracks active OpenClaw plugin sockets by `appId`
- `appRegistry`: tracks all registered apps loaded from `apps.json`
- `apps.json` stores `secretHash` only; the admin creation API returns the plaintext secret once
- `/ws`: browser WebSocket endpoint
- `/plugin`: OpenClaw plugin WebSocket endpoint
- heartbeat uses WebSocket ping/pong every 30 seconds
- server does not run OpenClaw logic; it only routes frames
- `app_list` contains online apps from `plugins`, while registry apps are the full `apps.json` set

---

## 4. Channel Plugin Manifest

### `plugin/openclaw.plugin.json`

```json
{
  "id": "openclaw-webchat-plugin",
  "kind": "channel",
  "channels": ["openclaw-webchat"],
  "name": "WebChat",
  "description": "Browser-based WebChat channel for OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "channelConfigs": {
    "openclaw-webchat": {
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
  "name": "openclaw-webchat-plugin",
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
      "id": "openclaw-webchat",
      "label": "WebChat",
      "selectionLabel": "WebChat",
      "docsPath": "/channels/openclaw-webchat",
      "docsLabel": "openclaw-webchat",
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
export const CHANNEL_ID = "openclaw-webchat";
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
 * 新配置格式：channels["openclaw-webchat"].accounts.{accountId}
 * 旧配置格式：channels["openclaw-webchat"].serverUrl（兼容过渡）
 */
/** 提取 channels["openclaw-webchat"] 段（对标 feishu 的 getLarkConfig） */
export function getWebChatConfig(cfg) {
  return cfg.channels?.["openclaw-webchat"] || {};
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
 * "openclaw-webchat": {
 *   "enabled": true,
 *   "accounts": {
 *     "my-instance": {
 *       "appId": "wch_abc123",
 *       "secret": "sk-xxx"
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
  id: "openclaw-webchat-plugin",
  name: "WebChat",
  description: "Browser WebChat channel for OpenClaw",
  configSchema: emptyPluginConfigSchema(),

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
  getWebChatAccount,
  getDefaultWebChatAccountId,
  isConfigured
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
  id: CHANNEL_ID,

  meta: {
    ...meta,
    quickstartAllowFrom: true
  },

  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true
  },

  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`]
  },

  config: {
    listAccountIds: (cfg) => listWebChatAccountIds(cfg),

    resolveAccount: (cfg, accountId) => {
      return getWebChatAccount(cfg, accountId || DEFAULT_ACCOUNT_ID);
    },

    defaultAccountId: (cfg) => {
      return getDefaultWebChatAccountId(cfg);
    },

    isConfigured: (account) => {
      return isConfigured(account);
    },

    describeAccount: (account) => {
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.serverUrl && account.appId && account.secret),
        serverUrl: account.serverUrl,
        appId: account.appId
      };
    },

    resolveAllowFrom: ({ account }) => {
      return account.allowFrom || ["*"];
    },

    formatAllowFrom: ({ allowFrom }) => {
      return allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.dmPolicy || "open",
        allowFrom: account.allowFrom || ["*"],
        approveHint: "Ask the operator to add your WebChat user id to allowFrom."
      };
    }
  },

  messaging: {
    normalizeTarget: (target) => {
      const trimmed = String(target || "").trim();
      return trimmed || undefined;
    },

    targetResolver: {
      looksLikeId: (id) => Boolean(String(id || "").trim()),
      hint: "<webchatUserId>"
    }
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => []
  },

  outbound: {
    deliveryMode: "gateway",

    chunker: (text, limit) => {
      return getWebChatRuntime().channel.text.chunkMarkdownText(text, limit);
    },

    textChunkLimit: TEXT_CHUNK_LIMIT,

    async sendText(params) {
      return sendOutgoingMessage({
        to: params.to,
        text: params.text || "",
        accountId: params.accountId || DEFAULT_ACCOUNT_ID,
        cfg: params.cfg
      });
    }
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null
    },

    collectStatusIssues(accounts) {
      return accounts.flatMap((entry) => {
        if (entry.enabled === false) return [];

        if (!entry.configured) {
          return [
            {
              channel: CHANNEL_ID,
              accountId: entry.accountId || DEFAULT_ACCOUNT_ID,
              kind: "config",
              message: "WebChat account is missing serverUrl, appId, or secret",
              fix: "Set channels.openclaw-webchat.serverUrl and channels.openclaw-webchat.accounts.<accountId>.appId/secret"
            }
          ];
        }

        return [];
      });
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null
    }),

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.serverUrl && account.appId && account.secret),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null
    })
  },

  gateway: {
    async startAccount(ctx) {
      const account = getWebChatAccount(ctx.cfg, ctx.accountId);

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
    },

    async logoutAccount(ctx = {}) {
      const account = getWebChatAccount(ctx.cfg || {}, ctx.accountId || DEFAULT_ACCOUNT_ID);
      await stopWebChatWsClient(account.accountId);

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
import { getWebChatAccount } from "./accounts.js";

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
  const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
  return String(to || "").replace(channelPrefix, "");
}

function buildInboundContext({ message, account, cfg }) {
  const core = getWebChatRuntime();

  const userId = String(message.userId);
  const conversationId = String(message.conversationId || userId);
  const content = String(message.content || "");

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: conversationId
    }
  });

  const agentId = route.agentId;
  if (!agentId) {
    throw new Error(`No agent binding found for ${CHANNEL_ID}/${account.accountId}`);
  }

  // Override sessionKey to isolate by (user, app)
  // 同一 appId 下，不同 userId → 不同 session，对话历史互不干扰
  route.sessionKey = `${CHANNEL_ID}:${userId}:${message.appId}`;  // appId 唯一 = 一个 Agent

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: content,
    RawBody: content,
    CommandBody: content,

    MessageSid: message.messageId || `webchat_${Date.now()}`,

    From: `${CHANNEL_ID}:${userId}`,
    To: `${CHANNEL_ID}:${conversationId}`,
    SenderId: userId,

    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",

    Timestamp: Date.now(),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${conversationId}`,

    CommandAuthorized: true,

    WebChatMessage: message,
    AgentId: agentId
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
      },

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
      },

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
      secret: account.secret
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

    if (message.type === "register_error") {
      state.authFailed = true;
      runtime.error?.(`[webchat] registration failed ${JSON.stringify(message)}`);
      setStatus?.({
        accountId: account.accountId,
        running: false,
        lastError: message.error || "registration_failed"
      });
      ws.close();
      return;
    }

    if (message.type === "pong") {
      state.lastPongAt = Date.now();
      return;
    }

    if (message.type === "app_list") {
      runtime.log?.(`[webchat] app_list ${JSON.stringify(message.apps || [])}`);
      return;
    }

    if (message.type === "incoming") {
      if (message.appId !== account.appId) {
        runtime.error?.(
          `[webchat] ignored incoming for appId=${message.appId}, expected=${account.appId}`
        );
        return;
      }

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
  if (state.authFailed) return;

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
    authFailed: false,
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
  -> Plugin 根据当前 accountId 查 bindings 映射 {channel, accountId} → agentId
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
  From: `openclaw-webchat:${userId}`,
  To: `openclaw-webchat:${conversationId}`,
  SenderId: userId,
  SessionKey: route.sessionKey,
  AccountId: route.accountId,
  ChatType: "direct",
  ConversationLabel: `user:${userId}`,
  Timestamp: Date.now(),
  Provider: "openclaw-webchat",
  Surface: "openclaw-webchat",
  OriginatingChannel: "openclaw-webchat",
  OriginatingTo: `openclaw-webchat:${conversationId}`,
  CommandAuthorized: true
});

await core.channel.session.recordInboundSession({
  storePath,
  sessionKey: ctxPayload.SessionKey || route.sessionKey,
  ctx: ctxPayload,
  updateLastRoute: {
    sessionKey: route.mainSessionKey || route.sessionKey,
    channel: "openclaw-webchat",
    to: `openclaw-webchat:${conversationId}`,
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
        to: `openclaw-webchat:${userId}`,
        text: payload.text,
        accountId: account.accountId
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
  deliveryMode: "gateway",

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
openclaw-webchat:u_123
```

The outgoing frame sent to Chat Server is:

```js
{
  type: "outgoing",
  appId: "wch_abc123",
  userId: "u_123",
  conversationId: "u_123",
  content: "reply text",
  messageId: "webchat_out_1710000000000"
}
```

---

## 13. Message History Storage

Chat Server stores recent chat history by `(userId, appId)`, not by `agentId`.

```js
const messageHistory = new Map();
// key = JSON.stringify([userId, appId])
// value = [{ from, appId, content, timestamp, messageId }, ...]
```

Record browser messages before routing to the Plugin, and record Plugin replies after validating that `outgoing.appId` matches the appId registered on that socket. On browser registration, return history grouped by appId:

```js
{
  type: "history",
  messages: {
    wch_abc123: [
      { from: "user", appId: "wch_abc123", content: "你好", timestamp: 1710000000000, messageId: "browser_..." },
      { from: "agent", appId: "wch_abc123", content: "你好，我是研发小虾。", timestamp: 1710000001000, messageId: "webchat_out_..." }
    ]
  }
}
```

Isolation rules:

- different `userId` values never share history
- the same `userId` has separate histories for each `appId`
- browser and server protocol messages still use `appId`; `agentId` stays inside Plugin binding resolution

---

## 14. Browser Client

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

## 15. Local Development

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
    "openclaw-webchat": {
      "enabled": true,
      "serverUrl": "wss://webchat.zeaho.site/plugin",
      "accounts": {
        "dev-main":   { "appId": "wch_abc123", "secret": "***" },
        "dev-helper": { "appId": "wch_def456", "secret": "***" },
        "cloud-main": { "appId": "wch_789ghi", "secret": "***" }
      }
    }
  },

  "bindings": [
    { "agentId": "main",   "match": { "channel": "openclaw-webchat", "accountId": "dev-main" } },
    { "agentId": "helper", "match": { "channel": "openclaw-webchat", "accountId": "dev-helper" } },
    { "agentId": "main",   "match": { "channel": "openclaw-webchat", "accountId": "cloud-main" } }
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
openclaw plugins inspect openclaw-webchat-plugin --runtime --json
openclaw channels status openclaw-webchat
```

Restart OpenClaw after linking if your runtime does not hot-load linked plugins.

---

## 16. Caddy Reverse Proxy

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
    "openclaw-webchat": {
      "enabled": true,
      "serverUrl": "wss://webchat.zeaho.site/plugin",
      "accounts": {
        "dev-main": { "appId": "wch_abc123", "secret": "***" },
        "dev-helper": { "appId": "wch_def456", "secret": "***" }
      }
    }
  },
  "bindings": [
    { "agentId": "main", "match": { "channel": "openclaw-webchat", "accountId": "dev-main" } },
    { "agentId": "helper", "match": { "channel": "openclaw-webchat", "accountId": "dev-helper" } }
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

## 17. Production Notes

Use `wss://` in production. Keep `ws://` only for local development.

Keep `/plugin` authenticated with the V2 `appId` + `secret` registration:

```json
{
  "type": "register",
  "appId": "wch_abc123",
  "secret": "***"
}
```

Validate `appId` + `secret` in `server.js` against `apps.json` before accepting plugin registration. Store only `secretHash` in `apps.json`; return the plaintext secret only once when an admin creates the app.

Add browser identity verification if the browser UI is public. Without auth, any browser can claim any `userId`.

Keep Chat Server stateless if possible. For multiple Chat Server instances, move connection routing behind sticky sessions or use Redis pub/sub for cross-instance delivery.

For offline support, add an `offlineMessages` store keyed by `userId`, then flush queued replies when the browser reconnects.

The minimal viable production version is:

- one Chat Server instance
- Caddy HTTPS
- appId + secret registration auth
- browser login or signed user token
- heartbeat cleanup
- structured logs for register, incoming, outgoing, disconnect, reconnect
- OpenClaw channel status reporting through `gateway.startAccount` / `setStatus`

---

## 16. Admin Panel (管理后台)

管理后台是 Chat Server 的 HTTP 管理界面，提供 web UI 用于管理 appId + secret 对和系统密码。与 WebSocket 消息通道完全分离，仅走 HTTP 协议。

### 概述

- 管理后台仅通过 HTTP 访问，不经过 WebSocket
- 浏览器打开 `http://CHAT_SERVER_HOST:3100/admin` 进入登录页
- 所有管理 API 需要 JWT 鉴权
- 仅供管理员/内网使用

### 依赖

需要在 `server/package.json` 中添加以下依赖：

```json
{
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2"
  }
}
```

- `bcryptjs`：密码和 secret 的哈希存储（已用于 Plugin 注册鉴权）
- `jsonwebtoken`：生成和验证管理员登录 JWT Token

### apps.json 初始化

Server 首次启动时，自动检测 `server/apps.json` 是否存在，若不存在则自动创建：

```json
{
  "adminPassword": "$2b$10$...",
  "apps": {}
}
```

- `adminPassword`：默认管理员密码 `admin`，使用 bcrypt 哈希后存储
- `apps`：空对象，后续通过管理后台添加 app 注册信息

初始化逻辑在 `server.js` 的启动流程中实现（`loadAppRegistry` 之前）：

```js
const APPS_FILE = path.join(__dirname, "apps.json");

function initAppsFile() {
  if (fs.existsSync(APPS_FILE)) return;

  const hash = bcrypt.hashSync("admin", 10);
  const data = {
    adminPassword: hash,
    apps: {}
  };

  fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log("[admin] created apps.json with default password");
}
```

### 数据结构（apps.json）

```json
{
  "adminPassword": "$2b$10$...",
  "apps": {
    "wch_abc123": {
      "appId": "wch_abc123",
      "secretHash": "$2b$10$...",
      "name": "研发小虾",
      "createdAt": "2026-05-31T10:00:00Z",
      "enabled": true
    }
  }
}
```

- `adminPassword`：管理员密码的 bcrypt hash
- `apps`：以 appId 为 key 的对象，每个 entry 包含 app 的元信息和 secretHash

### API Endpoints

所有管理 API 均以 `/api/admin/` 为前缀，需要 JWT 鉴权的请求需在 Header 中携带 `Authorization: Bearer <token>`。

#### 登录

**`POST /api/admin/login`**

- 请求体：`{ "password": "***" }`
- 响应：`{ "ok": true, "token": "***" }`
- Token 有效期：24 小时
- 使用 JWT 签名，密钥为服务器启动时生成的随机字符串

```js
const JWT_SECRET = crypto.randomBytes(32).toString("hex");

router.post("/api/admin/login", (req, res) => {
  const { password } = parseBody(req);
  const appData = readAppsFile();

  if (!appData.adminPassword || !bcrypt.compareSync(password, appData.adminPassword)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid_password" }));
    return;
  }

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "24h" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, token }));
});
```

#### JWT 鉴权中间件

```js
function requireAdmin(req, res) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "");

  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return false;
  }
}
```

#### 获取 App 列表

**`GET /api/admin/apps`**

- 返回所有已注册的 app 信息（不含 secret 原文）
- 响应示例：

```json
{
  "ok": true,
  "apps": [
    { "appId": "wch_abc123", "name": "研发小虾", "enabled": true, "createdAt": "2026-05-31T10:00:00Z" }
  ]
}
```

#### 创建 App

**`POST /api/admin/apps`**

- 请求体：`{ "name": "Agent 展示名称" }`
- 自动生成新的 appId + secret 对
- secret 明文仅在创建时返回一次，之后不可再次获取
- 响应示例：

```json
{
  "ok": true,
  "appId": "wch_a3f8c9e12b4d6f0a",
  "secret": "sk-wch-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "name": "研发小虾"
}
```

创建逻辑：

```js
function randomHex(len) {
  return crypto.randomBytes(len / 2).toString("hex");
}

router.post("/api/admin/apps", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name } = parseBody(req);
  if (!name) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "name_required" }));
    return;
  }

  const appId = "wch_" + randomHex(16);
  const secret = "sk-wch-" + randomHex(32);
  const secretHash = bcrypt.hashSync(secret, 10);

  const appData = readAppsFile();
  appData.apps[appId] = {
    appId,
    secretHash,
    name,
    createdAt: new Date().toISOString(),
    enabled: true
  };
  writeAppsFile(appData);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, appId, secret, name }));
});
```

#### 获取 App 详情

**`GET /api/admin/apps/:appId`**

- 返回指定 app 的详细信息（不包含 secret 原文）
- 响应示例：

```json
{
  "ok": true,
  "app": {
    "appId": "wch_abc123",
    "name": "研发小虾",
    "enabled": true,
    "createdAt": "2026-05-31T10:00:00Z"
  }
}
```

#### 删除 App

**`DELETE /api/admin/apps/:appId`**

- 删除指定的 appId 注册信息
- 已连接的 Plugin 不受影响（下次重连时验证失败）
- 响应：`{ "ok": true }`

#### 启用/禁用 App

**`PATCH /api/admin/apps/:appId`**

- 请求体：`{ "enabled": true }` 或 `{ "enabled": false }`
- `enabled: false` 临时停用 app，不影响已有连接；Plugin 下次重连时将被拒绝
- 响应：`{ "ok": true }`

#### 修改密码

**`PUT /api/admin/password`**

- 请求体：`{ "oldPassword": "...", "newPassword": "..." }`
- 新密码长度至少 6 位
- 验证旧密码正确后更新 `apps.json` 中的 `adminPassword` hash
- 响应：`{ "ok": true }`

### appId 生成规则

- 格式：`wch_` + 随机 16 位 hex 字符串
- 示例：`wch_a3f8c9e12b4d6f0a`
- 生成方式：`'wch_' + crypto.randomBytes(8).toString('hex')`
- 一个 appId 对应一个 Agent 身份

### secret 生成规则

- 格式：`sk-wch-` + 随机 32 位 hex 字符串
- 示例：`sk-wch-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`
- 生成方式：`'sk-wch-' + crypto.randomBytes(16).toString('hex')`
- `apps.json` 只保存 `secretHash`（bcrypt），secret 原文创建后不再存储
- 创建 app 时返回 secret 明文一次，之后不可再次获取

### Admin UI 页面

管理界面是独立的前端单页应用（与聊天前端分离），位于：

```text
server/
└── public/
    └── admin/
        ├── index.html      # 登录页
        └── dashboard.html   # 管理主页
```

**登录页（`index.html`）**

- 密码输入框 + 登录按钮
- 调用 `POST /api/admin/login` 获取 JWT token
- 成功后 token 存入 `sessionStorage`，跳转至 dashboard
- 页面不显示密码提示信息，仅作为管理入口

```html
<!-- 登录页核心逻辑 -->
<script>
async function login() {
  const password = document.querySelector("#password").value;
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (data.ok) {
    sessionStorage.setItem("admin_token", data.token);
    location.href = "/admin/dashboard.html";
  } else {
    alert("密码错误");
  }
}
</script>
```

**管理主页（`dashboard.html`）**

- 顶部栏：登录状态显示 + 退出登录按钮 + 修改密码入口
- 主体区域：app 列表表格
  - 列：appId, name, enabled 状态, createdAt 创建时间, 操作按钮（删除、启用/禁用）
- 操作弹窗：
  - 创建 app：输入 Agent 展示名称，确认后生成并展示 appId 和 secret（仅展示一次），提示用户复制保存
  - 修改密码：输入旧密码和新密码
- 所有 API 请求携带 `Authorization: Bearer <token>` Header

### 安全说明

- 所有管理 API 需要 `Authorization: Bearer <token>` Header，缺少或无效的 token 返回 401
- Token 存储在 `sessionStorage` 中，页面关闭即清除
- 密码和 token 仅通过 HTTP 传输，不经过 WebSocket
- 管理界面 `/admin/*` 返回静态 HTML，由 Server.js 的 HTTP 路由处理
- 生产环境建议：管理界面绑定到 localhost，仅通过 SSH 隧道或 VPN 访问，不对外暴露
- CORS 方面：如果管理 UI 和 Server 同源（同端口），无需额外配置；若分离部署需设置 `Access-Control-Allow-Origin`

### 密码重置

如果忘记管理员密码，可按以下步骤重置：

1. 编辑 `server/apps.json`，删除 `adminPassword` 字段
2. 重启 Chat Server
3. Server 启动时检测到 `adminPassword` 不存在，自动重新设置默认密码 `admin`（bcrypt 哈希后写入）
4. 使用默认密码 `admin` 登录后，建议立即修改密码

```js
function initAppsFile() {
  if (!fs.existsSync(APPS_FILE)) {
    // 首次创建：生成默认密码
    const hash = bcrypt.hashSync("admin", 10);
    fs.writeFileSync(APPS_FILE, JSON.stringify({ adminPassword: hash, apps: {} }, null, 2) + "\n");
    return;
  }

  // 已有 apps.json，检查 adminPassword
  const data = JSON.parse(fs.readFileSync(APPS_FILE, "utf8"));
  if (!data.adminPassword) {
    data.adminPassword = bcrypt.hashSync("admin", 10);
    fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2) + "\n");
    console.log("[admin] reset admin password to default");
  }
}
```

### 与已有功能的关系

- 管理后台修改 `apps.json`，Plugin 注册时 Server 读取 `appRegistry`（从 `apps.json` 加载）进行鉴权验证
- 创建 appId 后需要手动将 appId + secret 配置到 Plugin 侧的 `openclaw.json` 的 `accounts` 中
- 删除 app 不会断开已连接的 Plugin（在下次 Plugin 重连时验证失败）
- 禁用 app（`enabled: false`）不影响已有 WebSocket 连接，仅阻止新的 Plugin 注册
- 管理后台不参与消息路由，修改 `apps.json` 后需重新加载 `appRegistry` 使变更生效

### 统一响应和错误码

后台 API 全部返回 JSON，成功统一包含 `ok: true`，失败统一包含 `ok: false` 和 `error`。

```js
function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw new Error("body_too_large");
  }
  return raw.trim() ? JSON.parse(raw) : {};
}
```

通用错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `invalid_body` | JSON 无法解析、body 不是对象，或请求体过大 |
| 401 | `missing_token` | 缺少 `Authorization: Bearer <token>` |
| 401 | `invalid_or_expired_token` | JWT 无效或已过期 |
| 403 | `invalid_role` | JWT payload 中 `role` 不是 `admin` |
| 404 | `not_found` | 路由不存在 |
| 500 | `save_failed` | 写入 `apps.json` 失败 |

### 详细 API 规范

#### 1. 登录

```text
POST /api/admin/login
```

请求体：

```json
{ "password": "admin" }
```

成功响应：

```json
{ "ok": true, "token": "jwt-token", "expiresIn": 86400 }
```

错误响应：

```json
{ "ok": false, "error": "invalid_password" }
```

校验规则：

- `password` 必须是字符串
- `password.trim()` 不能为空
- 使用 `bcrypt.compare(password, store.adminPassword)` 验证
- JWT payload 固定为 `{ "role": "admin" }`
- JWT 过期时间固定为 24 小时

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `invalid_body` | 请求体不是合法 JSON |
| 400 | `password_required` | 缺少密码 |
| 401 | `invalid_password` | 密码不匹配 |
| 500 | `admin_password_not_initialized` | `adminPassword` 未初始化 |

```js
async function handleAdminLogin(req, res, store) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid_body" });
  }

  if (typeof body.password !== "string" || !body.password.trim()) {
    return sendJson(res, 400, { ok: false, error: "password_required" });
  }

  if (!store.adminPassword) {
    return sendJson(res, 500, { ok: false, error: "admin_password_not_initialized" });
  }

  const matched = await bcrypt.compare(body.password, store.adminPassword);
  if (!matched) {
    return sendJson(res, 401, { ok: false, error: "invalid_password" });
  }

  return sendJson(res, 200, {
    ok: true,
    token: jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "24h" }),
    expiresIn: 24 * 60 * 60
  });
}
```

#### 2. 获取 App 列表

```text
GET /api/admin/apps
```

请求体：无。

成功响应：

```json
{
  "ok": true,
  "apps": [
    {
      "appId": "wch_a3f8c9e12b4d6f0a",
      "name": "研发小虾",
      "enabled": true,
      "connected": false,
      "createdAt": "2026-06-02T10:00:00.000Z",
      "updatedAt": "2026-06-02T10:00:00.000Z"
    }
  ]
}
```

校验规则：

- 必须携带合法 JWT
- 不返回 `secretHash`
- 不返回 secret 原文
- `connected` 从 `plugins.has(appId)` 推导

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 401 | `missing_token` | 缺少 token |
| 401 | `invalid_or_expired_token` | token 无效或过期 |
| 403 | `invalid_role` | role 不合法 |

```js
function listAdminApps(store) {
  return Object.values(store.apps)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((app) => ({
      appId: app.appId,
      name: app.name,
      enabled: app.enabled !== false,
      connected: plugins.has(app.appId),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt || app.createdAt
    }));
}
```

#### 3. 创建 App

```text
POST /api/admin/apps
```

请求体：

```json
{ "name": "研发小虾" }
```

成功响应：

```json
{
  "ok": true,
  "app": {
    "appId": "wch_a3f8c9e12b4d6f0a",
    "name": "研发小虾",
    "enabled": true,
    "createdAt": "2026-06-02T10:00:00.000Z",
    "updatedAt": "2026-06-02T10:00:00.000Z"
  },
  "secret": "sk-wch-8f3a9c2e1b4d6f0a7c5e9b8d2a4f6c0e"
}
```

校验规则：

- 必须携带合法 JWT
- `name` 必须是字符串
- `name.trim()` 长度为 1 到 64
- `appId` 必须由 Server 生成，客户端不能指定
- `appId` 写入前必须检查唯一性
- `secret` 必须由 Server 生成，只在创建响应中返回一次
- `apps.json` 只保存 `secretHash`

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `invalid_body` | 请求体不是合法 JSON |
| 400 | `name_required` | 缺少名称 |
| 400 | `name_too_long` | 名称超过 64 字符 |
| 401 | `missing_token` | 缺少 token |
| 401 | `invalid_or_expired_token` | token 无效或过期 |
| 500 | `app_id_generation_failed` | 生成 appId 多次碰撞 |
| 500 | `save_failed` | 写入失败 |

```js
function generateAppId() {
  return `wch_${crypto.randomBytes(8).toString("hex")}`;
}

function generateSecret() {
  return `sk-wch-${crypto.randomBytes(16).toString("hex")}`;
}

function generateUniqueAppId(store) {
  for (let i = 0; i < 10; i += 1) {
    const appId = generateAppId();
    if (!store.apps[appId]) return appId;
  }
  throw new Error("app_id_generation_failed");
}
```

#### 4. 删除 App

```text
DELETE /api/admin/apps/:appId
```

请求体：无。

成功响应：

```json
{ "ok": true, "appId": "wch_a3f8c9e12b4d6f0a" }
```

校验规则：

- 必须携带合法 JWT
- `appId` 必须匹配 `/^wch_[0-9a-f]{16}$/`
- App 必须存在
- 删除后立即写回 `apps.json`
- 删除不强制断开已连接 Plugin；下次重连时注册失败

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `invalid_app_id` | appId 格式错误 |
| 401 | `missing_token` | 缺少 token |
| 401 | `invalid_or_expired_token` | token 无效或过期 |
| 404 | `app_not_found` | appId 不存在 |
| 500 | `save_failed` | 写入失败 |

#### 5. 启用 / 禁用 App

```text
PATCH /api/admin/apps/:appId
```

请求体：

```json
{ "enabled": false }
```

成功响应：

```json
{
  "ok": true,
  "app": {
    "appId": "wch_a3f8c9e12b4d6f0a",
    "name": "研发小虾",
    "enabled": false,
    "createdAt": "2026-06-02T10:00:00.000Z",
    "updatedAt": "2026-06-02T10:10:00.000Z"
  }
}
```

校验规则：

- 必须携带合法 JWT
- `appId` 必须匹配 `/^wch_[0-9a-f]{16}$/`
- App 必须存在
- `enabled` 必须是 boolean
- 禁用后拒绝新的 Plugin 注册
- 基础版不强制断开已有 Plugin 连接

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `invalid_body` | 请求体不是合法 JSON |
| 400 | `invalid_app_id` | appId 格式错误 |
| 400 | `enabled_required` | `enabled` 不是 boolean |
| 401 | `missing_token` | 缺少 token |
| 401 | `invalid_or_expired_token` | token 无效或过期 |
| 404 | `app_not_found` | appId 不存在 |
| 500 | `save_failed` | 写入失败 |

### 密码修改校验

```text
POST /api/admin/password
```

请求体：

```json
{ "oldPassword": "admin", "newPassword": "new-password" }
```

成功响应：

```json
{ "ok": true }
```

校验规则：

- 必须携带合法 JWT
- `oldPassword` 必须匹配当前 `adminPassword`
- `newPassword.trim()` 长度至少 6
- `newPassword` 不能等于 `oldPassword`
- 新密码用 bcrypt hash 写入 `apps.json`

错误码：

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `old_password_required` | 缺少旧密码 |
| 400 | `new_password_required` | 缺少新密码 |
| 400 | `new_password_too_short` | 新密码少于 6 位 |
| 400 | `password_unchanged` | 新旧密码相同 |
| 401 | `invalid_old_password` | 旧密码错误 |
| 500 | `save_failed` | 写入失败 |

### Admin UI 详细流程

登录页 `/admin`：

```text
打开 /admin
  → 如果 sessionStorage.adminToken 存在，跳转 /admin/dashboard
  → 输入密码
  → POST /api/admin/login
  → 成功：sessionStorage.setItem("adminToken", token)
  → 跳转 /admin/dashboard
  → 失败：显示错误并留在登录页
```

登录页错误处理：

- `password_required`：提示输入密码
- `invalid_password`：提示密码错误
- `admin_password_not_initialized`：提示服务端未初始化
- 网络错误：提示无法连接服务器
- 提交中禁用登录按钮，避免重复请求

Dashboard `/admin/dashboard`：

```text
打开 /admin/dashboard
  → 读取 sessionStorage.adminToken
  → 无 token：跳转 /admin
  → GET /api/admin/apps
  → 成功：渲染表格
  → 401：清理 token 并跳转 /admin
  → 其他错误：显示错误并保留页面
```

Dashboard 结构：

- 顶部工具栏：标题、创建 App、修改密码、退出登录
- App 表格：`name`、`appId`、`enabled`、`connected`、`createdAt`、操作按钮
- 创建 App modal
- 创建成功 secret 展示 modal
- 删除确认 modal
- 禁用确认 modal
- 修改密码 modal
- 全局错误提示区域

统一前端请求：

```js
async function adminFetch(path, options = {}) {
  const token = sessionStorage.getItem("adminToken");
  if (!token) {
    location.href = "/admin";
    throw new Error("missing_token");
  }

  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const data = await res.json();
  if (res.status === 401) {
    sessionStorage.removeItem("adminToken");
    location.href = "/admin";
  }
  if (!res.ok || !data.ok) throw new Error(data.error || "request_failed");
  return data;
}
```

创建 App modal：

```text
点击创建 App
  → 输入 name
  → POST /api/admin/apps { name }
  → 成功：刷新列表，打开 secret modal
  → secret modal 展示 appId + secret
  → 提示 secret 只显示一次
```

删除确认：

```text
点击删除
  → 弹窗展示 name + appId
  → 用户确认
  → DELETE /api/admin/apps/:appId
  → 成功刷新列表
  → 失败保留弹窗并显示错误
```

禁用确认：

```text
点击禁用
  → 弹窗展示 name + appId
  → 用户确认
  → PATCH /api/admin/apps/:appId { "enabled": false }
  → 成功刷新列表
  → 失败保留弹窗并显示错误
```

启用 App 可以直接调用 `PATCH /api/admin/apps/:appId { "enabled": true }`，成功后刷新列表。

退出登录：

```js
function logout() {
  sessionStorage.removeItem("adminToken");
  location.href = "/admin";
}
```

Token 存储必须使用：

```js
sessionStorage.setItem("adminToken", token);
```

不要使用 `localStorage`。关闭 tab 后后台登录态应自然清除。

### Plugin 注册校验联动

Plugin 注册 `/plugin` 时按 `apps.json` 校验：

```js
function isValidAppId(appId) {
  return /^wch_[0-9a-f]{16}$/.test(appId);
}

function isValidSecret(secret) {
  return /^sk-wch-[0-9a-f]{32}$/.test(secret);
}

async function verifyPluginRegistration(appId, secret, store) {
  if (!isValidAppId(appId)) return { ok: false, error: "invalid_app_id" };
  if (!isValidSecret(secret)) return { ok: false, error: "invalid_secret_format" };

  const app = store.apps[appId];
  if (!app) return { ok: false, error: "app_not_found" };
  if (app.enabled === false) return { ok: false, error: "app_disabled" };

  const matched = await bcrypt.compare(secret, app.secretHash);
  if (!matched) return { ok: false, error: "invalid_secret" };

  return { ok: true, app };
}
```

### CORS 和安全要求

- 后台 UI 和 API 默认同源部署，不需要 CORS
- 不要对 `/api/admin/*` 设置 `Access-Control-Allow-Origin: *`
- 如必须跨域，只允许 `ADMIN_ORIGIN` 指定的管理域名
- 生产环境必须使用 HTTPS
- 生产环境必须设置稳定的 `ADMIN_JWT_SECRET`
- `apps.json` 文件权限限制为 Server 运行用户可读写
- 所有后台响应设置 `Cache-Control: no-store`
- secret 原文只在创建 App 的响应中出现一次
- `name` 渲染到 HTML 前必须转义，避免 XSS
- 后台建议只允许内网、VPN、SSH tunnel 或反向代理 IP allowlist 访问

### 本地测试清单

```bash
cd server
npm install
ADMIN_JWT_SECRET=dev-secret node server.js
```

测试点：

- 首次启动自动生成 `apps.json`
- 删除 `adminPassword` 并重启后恢复默认密码 `admin`
- 默认密码 `admin` 可以登录
- 登录响应包含 24h JWT
- 无 token 访问 `/api/admin/apps` 返回 `missing_token`
- 创建 App 返回符合格式的 `appId` 和 `secret`
- `apps.json` 只保存 `secretHash`，不保存 secret 原文
- 重复创建不会覆盖已有 appId
- 禁用 App 后新的 Plugin 注册返回 `app_disabled`
- 删除 App 后新的 Plugin 注册返回 `app_not_found`
- 修改密码后旧密码不能登录
