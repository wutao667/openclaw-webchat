# WebChat3.0 架构方案

## 核心思路

WebChat 是一个 **OpenClaw Channel Plugin**，对标飞书和企微 channel，让用户通过浏览器直接和 OpenClaw Agent 对话。

**关键设计决策：Plugin 主动连 Chat Server（长连接），而不是 Chat Server 调 Plugin（webhook）。** 这样内网的 OpenClaw 实例也能用。

---

## V2 设计变更

### 问题：agentId 全局冲突

V1 设计在 Chat Server 侧用 `agentId` 作为路由标识，所有 Plugin 实例共用一个全局 agent 路由表。当两个 OpenClaw 实例都以 `agentId: "main"` 注册时，后者覆盖前者的记录，导致消息路由错乱。

### 变更概述

```
V1：Plugin 注册 { pluginId, agents[] } → Server 用 agentId 路由（agentId 全局唯一，有冲突风险）
V2：Plugin 注册 { appId, secret } → Server 按 appId 路由。Server 和 Browser 不感知 agentId，agentId 仅 Plugin 内部 bindings 中使用
```

| 项目 | 旧方案 | 新方案 |
|------|--------|--------|
| 注册标识 | pluginId（自声明） | **appId**（预分配，唯一） |
| 路由键 | agentId（全局唯一要求） | **appId**（Server 强制唯一） |
| 鉴权 | 无 | **Secret 签名认证** |
| 配置结构 | 扁平 `agents[]` | **accounts 多账号**，每个 account 对应 Server 端一个 App（appId + secret），一个 Gateway 部署可有多条 Account（对标飞书） |
| agentId 冲突 | 会覆盖 | 插件内部通过 bindings 映射，Server 不感知 agentId |

### 核心概念

**App（Agent 外部身份）**
- 一个 App 代表 Chat Server 上一个可被外部访问的 Agent 身份；App 不是 OpenClaw Gateway 部署，也不是 Plugin 实例
- 每个 App 有唯一 `appId`（Server 分配）和 `secret`（预共享密钥，Server 只保存 `secretHash`，不保存 secret 原文）
- App 在 Server 端注册，Server 按 `appId` 路由消息
- 一个 OpenClaw Gateway 可以配置多个 Account，对应 Chat Server 上多个 App

**Account（通道账号）**
- Plugin 侧配置，对标飞书 `channels.feishu.accounts`
- 每个 Account 绑定 Server 端一个 App（通过 `appId` + `secret`），App = Agent 身份
- 每个 Account 建立一条到 Chat Server 的 WebSocket 连接；Gateway 有 3 个 Account 就打开 3 条 WS 连接，每条连接注册一个 `appId`
- 通过 Gateway 全局 `bindings[]` 将 `{channel, accountId}` 映射到 `agentId`

---

## 架构总览

```
┌────────────────────────────────────────────────────────┐
│             管理员（浏览器）                             │
│  打开 /admin → 登录 → 管理 appId/secret                  │
│  HTTP（非 WebSocket）                                   │
└─────────────────────┬──────────────────────────────────┘
                      │ HTTP
                      ▼
┌────────────────────────────────────────────────────────┐
│                  用户端（浏览器）                         │
│  连接 Chat Server → 发消息 → 收回复                       │
└─────────────────────┬──────────────────────────────────┘
                      │ WebSocket
                      ▼
┌────────────────────────────────────────────────────────┐
│                Chat Server（公网）                       │
│                                                        │
│  职责：                                                │
│  - 管理浏览器 WebSocket 连接（心跳、重连、离线缓存）       │
│  - 管理 Plugin WebSocket 连接（接收 plugin 注册）         │
│  - 路由：浏览器消息 → 转发给对应的 Plugin                  │
│  - 推送：Plugin 回复 → 转发给浏览器                       │
│  - 管理后台：appId/secret CRUD、密码管理                  │
│  - 提供 /admin 管理界面（HTML）                          │
│  - app 注册鉴权验证（apps.json）                         │
│                                                        │
│  端口 :3100（HTTP + WebSocket）                         │
│  可部署在有公网 IP 的服务器上                              │
└─────────────────────┬──────────────────────────────────┘
                      │ ↑ WebSocket（长连接）
                      │ Plugin 主动连 Chat Server
                      │（内网机器也能出站连接）
                      ▼
┌────────────────────────────────────────────────────────┐
│              WebChat Channel Plugin                     │
│                                                        │
│  职责：                                                │
│  - 注册为 OpenClaw channel（api.registerChannel）        │
│  - 启动时主动 WS 连 Chat Server                          │
│  - 收到 Chat Server 的消息 → Core dispatch              │
│  - Core 回复 → 通过 WS 发回 Chat Server                  │
│                                                        │
│  写法对标飞书 WebSocket 模式                              │
└─────────────────────┬──────────────────────────────────┘
                      │ 标准 channel dispatch
                      ▼
┌────────────────────────────────────────────────────────┐
│                OpenClaw Core / Agent                     │
│                                                        │
│  处理消息，回复走标准 outbound.send()                     │
└────────────────────────────────────────────────────────┘
```

---

## 连接模型

### Plugin 注册连接（V2：带鉴权）

**前置条件：** Server 管理员预先分配 App，生成 `appId` + `secret`（通过 Server 管理接口或配置文件）。

Plugin 侧配置好 `appId` + `secret` 后启动连接：

```
Plugin 启动时：
1. 主动连 Chat Server 的 WS（wss://chat-server:3100/plugin）
2. 发送注册消息：{
     type: "register",
     appId: "wch_abc123",        // Server 预分配的唯一 ID，一个 appId = 一个 Agent
     secret: "sk-xxx"            // 预共享密钥，Server 仅用来校验 secretHash
   }
3. Server 验证 appId + secret：
   - 通过 → { type: "registered", ok: true, appId: "wch_abc123" }
   - 失败 → { type: "register_error", error: "invalid_app|invalid_secret" }
4. 连接持久保持
```

**变更要点：**
- 旧：pluginId 自声明，无鉴权，agentId 全局路由
- 新：appId 预分配 + secret 鉴权，Server 按 appId 路由，agentId 仅用于 Plugin 内部 dispatch（Plugin 通过 bindings 映射 `{channel, accountId}`→agentId）

### 浏览器连接

```
浏览器打开页面时：
1. 主动连 Chat Server 的 WS（wss://webchat.zeaho.site/ws）
2. 发送注册消息：{ type: "register", userId: "xxx" }
3. Chat Server 返回在线 app 列表（包含 appId，用于后续消息路由）
4. 连接持久保持
```

---

## 消息流程

### 用户发消息 → Agent 回复

```
浏览器 ──WS──→ Chat Server
                  │
                  │ 找到用户对应的 Plugin WS 连接
                  │
                  ├──(WS push)──→ Plugin
                  │                 │ dispatch
                  │                 ▼
                  │              Core → Agent
                  │                 │ reply
                  │                 ▼
                  │              outbound.send()
                  │                 │
                  ├──(WS push)──←──┘
                  │
                  └───WS──→ 浏览器
```

**详细步骤（V2）：**

1. 浏览器发消息 `{ type: "message", appId: "wch_abc123", content: "你好" }`（不携带 agentId）
2. Chat Server 按 `appId` 找到对应的 Plugin WS 连接
3. 通过 WS 推给 Plugin：`{ type: "incoming", appId: "wch_abc123", userId: "xxx", content: "你好" }`（无 agentId）
4. Plugin 收到 → 根据连接对应的 accountId，通过 bindings 映射 `{channel, accountId}` 到 agentId → resolveAgentRoute → Core dispatch
5. Agent 处理 → 回复 → Core 回调 `outbound.sendText()`
6. Plugin 通过 WS 发回 Chat Server：`{ type: "outgoing", appId: "wch_abc123", userId: "xxx", content: "我是哪吒" }`（无 agentId）
7. Chat Server 推给对应的浏览器

---

## 接口/协议定义

### Plugin ↔ Chat Server（WS 长连接）

Plugin 连接地址：`wss://CHAT_SERVER_HOST:3100/plugin`

**Plugin → Chat Server：**

```json
// 注册（V2：带 appId + secret 鉴权）
{
  "type": "register",
  "appId": "wch_abc123",
  "secret": "sk-xxx"
}

// 转发回复给用户
{
  "type": "outgoing",
  "appId": "wch_abc123",
  "userId": "u_xxx",
  "content": "我是哪吒"
}
```

**Chat Server → Plugin：**

```json
// 注册确认
{ "type": "registered", "ok": true, "appId": "wch_abc123" }

// 注册失败
{ "type": "register_error", "error": "invalid_secret" }

// 用户消息（按 appId 路由到对应的 Plugin）
{
  "type": "incoming",
  "userId": "u_xxx",
  "appId": "wch_abc123",
  "content": "你好"
}

// 在线 App 列表更新（当前已连接 Plugin 的 apps，不是 apps.json 全量注册表）
{ "type": "app_list", "apps": [
  { "appId": "wch_abc123", "name": "研发小虾" },
  { "appId": "wch_def456", "name": "悟空" }
] }
```

**变更要点：**
- 注册消息新增 `appId` + `secret` 字段，替代 `pluginId`
- Server 返回 `register_error` 类型用于鉴权失败
- `incoming` 消息新增 `appId` 字段，明确目标 Plugin
- `outgoing` 消息新增 `appId` 字段。agentId 仅在 Plugin 内部通过 bindings 映射
- `app_list` 消息使用 `apps` 数组，表示当前在线 apps（已连接的 Plugin 连接）。管理后台的 registry apps 表示 `apps.json` 中所有已注册 apps，二者语义不同

### 浏览器 ↔ Chat Server（WS 长连接）

浏览器连接地址：`wss://webchat.zeaho.site/ws`

**浏览器 → Chat Server：**

```json
// 注册
{ "type": "register", "userId": "吴涛" }

// 发消息（指定目标 appId，无需 agentId）
{
  "type": "message",
  "appId": "wch_abc123",
  "content": "你好"
}
```

**Chat Server → 浏览器：**

```json
// 注册确认
{ "type": "registered", "userId": "u_xxx" }

// app 列表（每个 app = 一个 Agent，appId 全局唯一）
{
  "type": "app_list",
  "apps": [
    { "appId": "wch_abc123", "name": "研发小虾" },
    { "appId": "wch_def456", "name": "悟空" }
  ]
}

// 收到回复
{
  "type": "message",
  "from": "agent",
  "appId": "wch_abc123",
  "content": "我是哪吒"
}
```

**变更要点：**
- 浏览器发消息仅需携带 `appId`，无需 `agentId`。Server 按 appId 路由到对应 Plugin 连接，Plugin 再按该连接的 accountId 通过 bindings 映射到对应 agent
- 前端在线 app 列表按 `appId` 展示（每个 app = 一个 Agent），展示 name 即可，不需要 agentId
- 回复消息携带 `appId` 字段，前端据此匹配到对应会话

---

## 和飞书/企微的对照

| | 飞书 | 企微 | WebChat |
|---|---|---|---|
| **连接方向** | Plugin 连飞书 WS | **Plugin 连企微 WS** | **Plugin 连 Chat Server WS** |
| **通信方式** | WS 长连接 | WS 长连接 | **WS 长连接** |
| **内网友好？** | ✅ | ✅ | ✅ |
| **Plugin 需要公网IP？** | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 |
| **谁主动** | Plugin 主动连 | Plugin 主动连 | Plugin 主动连 |

### Plugin 侧配置格式（accounts + bindings）

与飞书/企微一致，WebChat Plugin 的配置分两层：

1. **accounts**：定义多个 Agent 的连接凭据，**每个 account 对应一个 App（一个 appId = 一个 Agent）**
2. **bindings**：全局 `bindings[]` 将 `{channel, accountId}` 映射到 OpenClaw 的 `agentId`

> ⚠️ **核心原则**：一个 appId 对应唯一一个 Agent。同一台 OpenClaw 主机上有多个 Agent，就需要多个 account，各自绑定不同的 agentId。与飞书/企微完全一致——一个 OpenClaw 实例注册一个 feishu account，如需多个 Agent 则各自有独立的 feishu account。

**openclaw.json 示例（一台机器两个 Agent + 另一台机器一个 Agent）：**

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

**说明：**

- `accounts.{accountId}` — 每个 account 对应 Server 端一个 App（一个 Agent 的身份），通过 appId 关联。一个 OpenClaw 部署有 N 个 Agent 就配 N 个 account（N 个 appId）
- `bindings[]` — 全局层，将 `{channel, accountId}` 映射到 OpenClaw 的 `agentId`。这是 OpenClaw 标准的 agent 路由机制，飞书/企微也是同样用法
- **Server 不感知 agentId**，只根据 appId 路由消息。appId `wch_abc123` 的消息只会发给注册了它的 Plugin 连接，Plugin 根据该连接对应的 accountId 通过 bindings 确定 agentId
- 同一个 agentId（如 `main`）可以在不同 account 下重复（不同 OpenClaw 实例），Server 端 appId 全局唯一，互不干扰

## 多实例场景

```
     浏览器 ──┐
     浏览器 ──┼── Chat Server（公网 :3100）
     浏览器 ──┘     │
              ┌─────┼─────┐
              │     │     │
           Plugin1 Plugin2 Plugin3
           (本机)  (云主机) (内网机器)
              │        │       │
           Agent A  Agent B  Agent C
           (main)  (helper)  (main)
           appId_1  appId_2  appId_3
```

所有 Plugin 都**主动 WS 连接**到公网 Chat Server。每个 Account 用一个 appId 注册，一个 App = 一个 Agent。一个 Gateway 部署（Plugin）可有多个 Account 对应多个 App。浏览器连 Chat Server 后，从 app 列表中选择一个 Agent 对话。Chat Server 根据 **appId** 路由消息。

---

## 领域模型

### 实体定义

| 实体 | 属性 | 职责 |
|------|------|------|
| **User** | userId | 真人用户标识，通过浏览器与 Agent 对话 |
| **Browser/Tab** | WebSocket, userId, lastSeen | 用户的多设备/多 tab 连接，同一 userId 可有多个 |
| **Chat Server** | browsers{}, plugins{}, appRegistry{} | 全局路由中心，维护所有 WS 连接，按 appId 路由到对应 Plugin |
| **App** | appId, secretHash, name, enabled, createdAt | Chat Server 上一个可被外部访问的 Agent 身份。Server 侧注册的唯一凭证，`appId` 全局唯一，与 Plugin 侧 **Account** 一一对应。一个 Gateway 部署可有多个 Account/App（多个 Agent 各自独立 appId）。由管理后台创建/删除，创建时录入 display name；secret 原文仅创建时返回一次 |
| **Admin** | password(bcrypt), token, JWT | 管理后台的登录凭证。初始密码 `admin`，可修改。密码以 bcrypt 存储在 `apps.json` |
| **Apps.json** | adminPassword, apps{appId→{secretHash,name,enabled,createdAt}} | Server 端的持久化文件，保存管理员密码 hash 和所有已注册 app 信息。管理后台 CRUD 操作的目标，不保存 secret 原文 |
| **Plugin Instance** | appId, ws, accountId | 每个 OpenClaw 部署一个 Plugin，可配置多个 Account；每个 Account 主动建立一条长连并注册一个 appId |
| **Account** | accountId, appId, secret | Plugin 侧配置，对标飞书 accounts。与 Server 端 App 一一对应（通过 appId）。仅包含连接凭据（serverUrl 为 channel 公共配置），通过 bindings 绑定到 agentId |
| **Agent** | agentId, name | Plugin 侧的 AI 对话代理。agentId 通过 bindings 与 Server 端 App 关联，仅 Plugin 内部可见 |
| **OpenClaw Session** | sessionKey("openclaw-webchat:{userId}:{appId}"), history | Core 管理，按 (用户, app) 二元组隔离会话（appId 全局唯一，= 一个 Agent），跨消息持久化 |
| **Message** | type, userId, appId, content, messageId | 消息载体，在三条路径间流转。agentId 仅在 Plugin 内部通过 bindings 映射 |

### 关系图

```
                        ┌──────────────┐
                        │    User      │  (人，多个)
                        │  userId: str │
                        └──────┬───────┘
                               │ 1 人开多个浏览器 tab
                               ▼
                     ┌──────────────────┐
                     │  Browser/Tab     │  (WebSocket 连接)
                     └────────┬─────────┘
                              │ 连接 host/ws
                              ▼
┌──────────────────────────────────────────────────────────┐
│                   Chat Server                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ browsers     │  │ plugins                       │   │
│  │ userId ->    │  │ appId -> {ws, appId, name}    │   │
│  │   Set<WS>    │  │                               │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│  路由: browser msg(appId) → plugins.get(appId)       │
│        → appId → plugin.ws → {type:"incoming"}       │
│       plugin reply(userId) → browsers[userId]          │
└──────────────────┬───────────────────────────────────────┘
                   │ Plugin 主动 WS 连接（内网友好）
                   ▼
┌──────────────────────────────────────────────────────────┐
│               Plugin Instance (每 OpenClaw 部署)          │
│                                                           │
│  ┌──────────────────┐  ┌──────────────────┐              │
│  │ ws-client.js     │◄─┤ ws (连 Chat Server/plugin)│    │
│  │ (心跳/重连/收发)  │  └──────────────────┘              │
│  └────────┬─────────┘                                      │
│           │                                                │
│  ┌────────▼──────────────────────────────┐                │
│  │ dispatchIncoming(userId, content)      │                │
│  │ → resolveAgentRoute()                  │                │
│  │ → resolveStorePath() → sessionKey      │                │
│  │ → finalizeInboundContext()             │                │
│  │ → recordInboundSession()              │                │
│  │ → dispatchReplyWithBufferedDispatcher()│               │
│  └────────────────┬───────────────────────┘               │
│                   │                                        │
│           ┌───────┴────────┐                               │
│           ▼                ▼                               │
│    ┌────────────┐   ┌──────────┐                           │
│    │  Agent     │   │  Agent   │  (每个 Plugin 可注册     │
│  │ bindings→agentId ││ appId 路由  │   多个 Agent)            │
│    └────────────┘   └──────────┘                           │
│           │                                                │
│  ┌────────▼──────────────────────────┐                    │
│  │  OpenClaw Core Session            │                    │
│  │  sessionKey = "openclaw-webchat:{userId}:{appId}"    │             │
│  │  (每个 user 独立会话，跨重启持久化)  │                    │
│  └───────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────┘
```

### 核心关系

**User ↔ Browser（1:N）**
- 一个用户可在多个浏览器/设备/tab 打开
- `browsers`：`userId → Set<WebSocket>`
- Chat Server 发回复时给所有 tab 推送
- 关掉一个 tab 不影响其他 tab

**Browser ↔ Chat Server（N:1）**
- 所有浏览器 WS 连接汇聚到同一个公网 Chat Server
- 连接路径：`wss://host/ws`
- 注册后 Server 返回当前在线 app 列表

**App（Plugin Instance）↔ Plugin Socket（1:1）**
- 每个 App 对应一个 WebSocket 连接
- `plugins`：`appId → { ws, appId, name, connectedAt }`
- 注册时需用 `appId` + `secret` 鉴权
- 断线自动重连（指数退避 2s→30s）
- **内网不需要公网 IP**，只要能出站访问 Chat Server 即可

**Agent 身份 ↔ App（1:1 external identity）**
- 每个 App 是 Chat Server 上一个独立的外部 Agent 身份；同一个 OpenClaw Gateway 可通过多个 Account 暴露多个 App
- Server 按 `appId` 路由消息：browser msg(appId) → plugins[appId] → plugin WS
- agentId 仅用于 Plugin 内部 resolveAgentRoute（通过 bindings 映射），浏览器和 Server 不感知

✅ **V2 解决冲突**：两个 Plugin 注册相同的 agentId 不再冲突，因为 Server 按 appId 路由，Plugin 内部通过 bindings 映射。浏览器和 Server 完全不感知 agentId

**User ↔ Agent（N:M via Session）**
- 用户选不同 Agent 对话，同 Agent 服务不同用户
- **同一 appId（同一 Agent）下，不同 userId 对应不同 session**。例如 appId=wch_abc123，UserA 的 sessionKey 是 `openclaw-webchat:UserA:wch_abc123`，UserB 的是 `openclaw-webchat:UserB:wch_abc123`，互不干扰，历史隔离
- Plugin 发消息时使用当前 account 的 appId；agentId 由 `{channel, accountId}` bindings 在 Plugin 内部解析
- Core 按 `sessionKey = "openclaw-webchat:{userId}:{appId}"` 管理会话（appId 全局唯一，= 一个 Agent）
- 每个 `(userId, appId)` 组合有独立对话历史
- sessionKey 格式：`"openclaw-webchat:{userId}:{appId}"`

**Session 生命周期**
```
Browser 第一次发消息
  → Chat Server 路由到 Plugin
  → Plugin dispatchIncoming()
  → finalizeInboundContext(route.sessionKey, agentId)
  → route.sessionKey = "openclaw-webchat:{userId}:{appId}"  ← 按用户+app隔离（appId 唯一对应一个 Agent）
  → recordInboundSession()           ← 创建/恢复 Core Session
  → dispatchReplyWithBufferedBlockDispatcher()
  → Agent 处理 → 回复
  → outbound.sendText() → sendOutgoingMessage(userId, content)
  → Chat Server 推送 → Browser
```

- Session 由 Core 按 `channel:chatId` 管理，chatId = userId
- **跨浏览器重启持久化**（Core 保存对话历史）
- **用户间隔离**：不同 userId 的数据互不干扰

### 多实例数据流示例（V2：按 appId 路由）

```
UserA (浏览器tab1) ──┐
UserA (浏览器tab2) ──┤
UserB (浏览器) ──────┤──── Chat Server (:3100)
                     │    ├── plugins["wch_abc123"] → ws(nezha机器)
                     │    │    → apps: [{appId:"wch_abc123", name:"研发小虾"}]
                     │    │
                     │    └── plugins["wch_def456"] → ws(wukong机器)
                     │         → apps: [{appId:"wch_def456", name:"悟空"}]
                     │
         ┌───────────┴───────────┐
         │                       │
    app: wch_abc123          app: wch_def456
    (nezha 机器)              (wukong 机器)
    agent: main (研发小虾)     agent: main (悟空)
```

- UserA 选 "悟空"（appId: wch_def456）→ 浏览器发 `{ type: "message", appId: "wch_def456", content: "..." }` → Server 查 `plugins["wch_def456"]` → 推给对应 Plugin 连接 → Plugin 按该连接的 accountId 通过 bindings 映射到 agentId → dispatch → Agent 回复
- UserB 选 "研发小虾"（`wch_abc123/main`）→ 同理按 appId 路由到另一台机器
- ✅ 两个 agentId 都是 "main"，但按 appId 区分，不会冲突

### 一句话总结

**Chat Server** 是连接路由器（User ↔ Plugin），**Plugin** 是消息转换器（WebSocket ↔ Core dispatch），**Agent** 是消息处理器，**Session** 是对话历史容器。整体架构是把飞书/企微的外部队长连模式嫁接到浏览器场景。

---

## 前端交互设计

### 页面结构

```
┌─────────────────────────────────────┐
│         登录页                       │
│                                     │
│  用户名： [________________]        │
│                                     │
│        [  进入聊天  ]               │
└─────────────────────────────────────┘
          │ 登录成功
          ▼
┌─────────────────────────────────────┐
│  Agent 列表         ← 显示所有可用   │
│                       Agent         │
│  ┌───────────────────────────────┐  │
│  │ 哪吒 (nezha)                 │  │
│  │ 上次对话: 2分钟前             │  │
│  ├───────────────────────────────┤  │
│  │ Cloud (cloud)                │  │
│  │ 上次对话: 昨天                │  │
│  ├───────────────────────────────┤  │
│  │ R2D2 (r2d2)                  │  │
│  │ 上次对话: 新                  │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
          │ 点击 Agent
          ▼
┌─────────────────────────────────────┐
│  Chat  ← Agent: 哪吒              │
│                                     │
│  用户: 你好              10:30     │
│  ─────────────────────────────      │
│  Agent: 我是哪吒           10:30   │
│  有什么可以帮你？                   │
│                                     │
│  ┌──────────────────────────────┐   │
│  │ 输入消息...       [发送]     │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### 三屏设计

**第一屏——登录**
- 输入 userId（自由填写，无密码）
- 点击进入后建立 WebSocket 连接
- 发送 `{ type: "register", userId }`
- Server 返回 `app_list` 后自动跳转到 Agent 选择页

**第二屏——Agent 选择**
- 仅展示当前可用的 Agent（从 app_list 获取）
- 每个 Agent 卡片显示：头像（首字母/emoji）、名称、上次对话时间
- 点击 Agent → 进入聊天页
- 底部展示当前登录用户身份，可退出重新登录

**第三屏——聊天**
- 顶部：Agent 名称 + 返回按钮（回到 Agent 选择页）
- 中间：消息列表（按时间倒序，从旧到新）
- 底部：输入框 + 发送按钮
- 消息气泡：用户消息右对齐（蓝色），Agent 回复左对齐（灰色）

### 消息与历史管理（V2：按 appId 关键键）

**前端状态划分：**

```
全局状态（Chat Server 级别）：
  - ws: WebSocket 连接
  - userId: 当前用户身份
  - apps: App 列表（每条含 appId, name）。agentId 仅 Plugin 内部使用，前端不感知

会话状态（按 (userId, appId) 划分，appId 唯一 = 一个 Agent）：
  - activeAppId: 当前选中的 App
  - messages[appId]: 每个 Agent（= 每个 appId）的独立消息列表
    - messages["wch_abc123"] = [{ role, content, time }, ...]
    - messages["wch_def456"] = [{ role, content, time }, ...]
```

**变更要点：**
- 旧：`messages[agentId]` 按 agentId 分流
- 新：agentId 不出现在前端。`messages[appId]` 按 appId 分流（appId 全局唯一，= 一个 Agent）

**历史记录加载：**
- 连接建立后，Chat Server 初次返回可携带该 userId 的最近消息历史
- 前端按 appId 分流存储到 messages[appId] 中
- 切换 Agent 时读取对应的 messages[appId]，不需要重新请求（appId 唯一 = 一个 Agent）
- 新消息实时追加到对应 Agent 的消息列表

**消息渲染逻辑：**
- 收到 `{ type: "message", appId: "wch_abc123", from: "agent", content: "..." }` → 按 appId 追加到 messages["wch_abc123"] → 追加到 `messages["wch_abc123"]`
- 如果当前 `activeAppId === "wch_abc123"`，把消息显示到聊天区
- 否则不显示，但在 Agent 卡片上标红点/未读提示

### 多 Agent 隔离示例（V2：按 appId 路由）

```
用户 "u_alice" 登录 →
  ws.register({ userId: "Alice" })
  → Server 返回 app_list: [
       { appId: "wch_abc123", name: "研发小虾" },
       { appId: "wch_def456", name: "悟空" }
     ]

Alice 点 "研发小虾" (appId: wch_abc123) →
  发送消息 { type: "message", appId: "wch_abc123", content: "你好" } (不携带 agentId)
  → messages["wch_abc123"] = [{ role:"user", content:"你好" }]
  → 收到回复 { type: "message", appId: "wch_abc123", content: "我是研发小虾" }
  → messages["wch_abc123"].push({ role:"agent", content:"我是研发小虾" })
  → 聊天区显示对话

Alice 切到 "悟空" (appId: wch_def456) →
  → 聊天区切换到 messages["wch_def456"]（独立的历史）
  → 发送新消息 { type: "message", appId: "wch_def456", content: "帮我查天气" } (不携带 agentId)
  → 消息路由到 appId: wch_def456 对应的 Plugin

切换回 "研发小虾" →
  → 聊天区显示 messages["wch_abc123"]，之前的对话完整保留
```

### 后端消息存储（V2：按 appId 关键键）

Chat Server 需要按 `(userId, appId)` 存储最近 N 条消息（appId 唯一标识一个 Agent）：

```
messageHistory = Map<string, Message[]>
// key = `${userId}:${appId}`（appId 全局唯一 = 一个 Agent）
// value = [{ role, content, timestamp, messageId }, ...]
```

```text
Browser register
  → Server 查 messageHistory，按 (appId) 分组返回（每个 appId = 一个 Agent）
  → 格式: {
      type: "history",
      messages: {
        "wch_abc123": [...],
        "wch_def456": [...]
      }
    }
```

**隔离规则：**
- userId 不同 → 互相看不到任何数据
- userId 相同、appId 不同 → 看到各自的独立历史
- userId 相同、appId 不同 → 该用户的不同 Agent 的历史（每个 appId 对应一个独立的 Agent）
- 无密码/无认证，信任 userId 的自声明（未来可加 token/auth）

---

## 管理后台

Chat Server 提供 HTTP 管理后台（仅内网/管理员可访问），用于管理 appId + secret 对和系统密码。

### 访问方式

```
http://CHAT_SERVER_HOST:3100/admin
```

浏览器打开 `/admin` 进入登录页面，输入密码后进入管理界面。

### 登录

- 路径：`POST /api/admin/login`
- 请求体：`{ "password": "..." }`
- 响应：成功返回 `{ "ok": true, "token": "***" }`，后续请求通过 Header `Authorization: Bearer <token>` 鉴权
- 登录态使用 JWT token，过期时间 24 小时

### 初始密码

- 初始密码：`admin`
- 首次部署时 Server 自动生成 `apps.json`，包含初始密码的 bcrypt hash
- 建议首次登录时强制修改密码

### 密码管理

**修改密码**

- 路径：`POST /api/admin/password`
- 请求体：`{ "oldPassword": "...", "newPassword": "..." }`
- 密码长度至少 6 位
- 密码以 bcrypt hash 存储在 `apps.json` 中

**重置密码**

- 如果忘记密码，可手动编辑 `apps.json` 将 `adminPassword` 字段删除
- Server 重启后检测到无密码，自动重新设置为默认 `admin`

### appId + secret 管理

管理界面提供 CRUD 界面管理 app 注册信息，存储在 `apps.json`。

**数据结构（apps.json）**

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
    },
    "wch_def456": {
      "appId": "wch_def456",
      "secretHash": "$2b$10$...",
      "name": "小助手",
      "createdAt": "2026-05-31T10:00:00Z",
      "enabled": true
    },
    "wch_789ghi": {
      "appId": "wch_789ghi",
      "secretHash": "$2b$10$...",
      "name": "哪吒(PROD)",
      "createdAt": "2026-05-31T11:00:00Z",
      "enabled": true
    }
  }
}
```

**管理 API**

| 操作 | HTTP 接口 | 说明 |
|------|-----------|------|
| 列表 | `GET /api/admin/apps` | 返回所有已注册的 app 信息（不含 secret 原文） |
| 创建 | `POST /api/admin/apps` | 生成新 `appId` + `secret` 对，body 必填 `{ name: "..." }`（Agent 展示名称） |
| 详情 | `GET /api/admin/apps/:appId` | 返回指定 app 的详细信息 |
| 删除 | `DELETE /api/admin/apps/:appId` | 删除 app，已连接的 Plugin 不受影响（下次重连时被拒绝） |
| 启用/禁用 | `PATCH /api/admin/apps/:appId` | `{ "enabled": false }` 临时停用 app，不影响已有连接 |

### appId 生成规则

- 格式：`wch_` + 随机 16 位 hex 字符串
- 示例：`wch_a3f8c9e12b4d6f0a`

### secret 生成规则

- 格式：`sk-wch-` + 随机 32 位 hex 字符串
- 示例：`sk-wch-8f3a9c2e1b4d6f0a7c5e9b8d2a4f6c0e`
- 创建时 Server 生成并返回，后续不再暴露原文；`apps.json` 只保存 `secretHash`（bcrypt）

### 管理界面 UI

管理界面是独立的 HTML 单页应用（与用户聊天前端分离），路径：

- `server/public/admin/index.html` — 登录页
- `server/public/admin/dashboard.html` — 管理主页

**页面设计**

1. **登录页** `/admin`：密码输入框 + 登录按钮，成功后跳转 dashboard
2. **管理主页** `/admin/dashboard`：
   - 顶部：当前登录状态 + 退出登录 + 修改密码入口
   - 主体：app 列表表格（appId, name, enabled, createdAt）+ 创建/删除/启用禁用操作
   - 操作弹窗：创建 app（即创建一个 Agent 身份）时需要填写 agent 展示名称（如"研发小虾"），保存后生成并展示 `appId` 和 `secret`（仅展示一次），提示用户复制保存。一个 appId 对应一个 Agent，一个 Gateway 部署可有多个 appId

**安全说明**

- 所有管理 API 需要 `Authorization: Bearer <token>` Header
- password 和 token 不通过 WebSocket 传输，仅走 HTTP
- 管理界面 `/admin/*` 返回静态 HTML，由 Server.js 的 HTTP 路由处理
- 生产环境建议：管理界面绑定到 localhost，仅通过 SSH 隧道或 VPN 访问

### 与已有功能的关系

- 管理后台修改 `apps.json`，Plugin 注册时 Server 读取 `apps.json` 进行鉴权验证
- 创建 appId 后需要手动将 appId + secret 配置到 Plugin 侧的 `openclaw.json` 的 accounts 中
- 删除 appId 不会断开已连接的 Plugin（在下次 Plugin 重连时验证失败）

---

## 开发路线

### Phase 1：Chat Server（基础版）
- HTTP + WS 服务，`:3100`
- 接受浏览器 WS 连接
- 接受 Plugin WS 连接
- 消息路由：浏览器 ↔ Plugin
- 简单前端页面（发消息 + 看回复）

### Phase 2：Channel Plugin
- 标准 `api.registerChannel()` + `outbound.send()`
- 启动时 WS 连 Chat Server
- 收到 message → Core dispatch
- Core 回复 → 通过 WS 发回 Chat Server

### Phase 3：集成测试 & 多实例
