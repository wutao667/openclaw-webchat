# WebChat3.0 架构方案

## 核心思路

WebChat 是一个 **OpenClaw Channel Plugin**，对标飞书和企微 channel，让用户通过浏览器直接和 OpenClaw Agent 对话。

**关键设计决策：Plugin 主动连 Chat Server（长连接），而不是 Chat Server 调 Plugin（webhook）。** 这样内网的 OpenClaw 实例也能用。

---

## 架构总览

```
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

### Plugin 注册连接

```
Plugin 启动时：
1. 主动连 Chat Server 的 WS（ws://chat-server:3100/plugin）
2. 发送注册消息：{ type: "register", pluginId: "webchat-channel", agents: ["nezha"] }
3. Chat Server 确认：{ type: "registered", ok: true }
4. 连接持久保持
```

### 浏览器连接

```
浏览器打开页面时：
1. 主动连 Chat Server 的 WS（wss://test.huaguo.site/ws）
2. 发送注册消息：{ type: "register", userId: "xxx", userName: "吴涛" }
3. Chat Server 返回 agent 列表
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

**详细步骤：**

1. 浏览器发消息 `{ type: "message", content: "你好" }`
2. Chat Server 通过 WS 推给 Plugin：`{ type: "incoming", userId: "xxx", content: "你好" }`
3. Plugin 收到 → Core dispatch（标准 dispatch 链）
4. Agent 处理 → 回复 → Core 回调 `outbound.send()`
5. Plugin 的 `outbound.send()` 通过 WS 发回 Chat Server：`{ type: "outgoing", userId: "xxx", content: "我是哪吒" }`
6. Chat Server 推给对应的浏览器

---

## 接口/协议定义

### Plugin ↔ Chat Server（WS 长连接）

Plugin 连接地址：`ws://CHAT_SERVER_HOST:3100/plugin`

**Plugin → Chat Server：**

```json
// 注册
{ "type": "register", "pluginId": "nezha-plugin", "agents": ["nezha"] }

// 转发回复给用户
{ "type": "outgoing", "userId": "u_xxx", "content": "我是哪吒" }
```

**Chat Server → Plugin：**

```json
// 注册确认
{ "type": "registered", "ok": true }

// 用户消息
{ "type": "incoming", "userId": "u_xxx", "userName": "吴涛", "content": "你好" }

// agent 列表更新
{ "type": "agent_list_update", "agents": [{"agentId": "nezha", "name": "哪吒"}] }
```

### 浏览器 ↔ Chat Server（WS 长连接）

浏览器连接地址：`wss://test.huaguo.site/ws`

**浏览器 → Chat Server：**

```json
// 注册
{ "type": "register", "userId": "u_xxx", "userName": "吴涛" }

// 发消息
{ "type": "message", "content": "你好" }
```

**Chat Server → 浏览器：**

```json
// 注册确认
{ "type": "registered", "userId": "u_xxx" }

// agent 列表
{ "type": "agent_list", "agents": [{"agentId": "nezha", "name": "哪吒"}] }

// 收到回复
{ "type": "message", "from": "agent:nezha", "content": "我是哪吒" }
```

---

## 和飞书/企微的对照

| | 飞书 | 企微 | WebChat |
|---|---|---|---|
| **连接方向** | Plugin 连飞书 WS | **Plugin 连企微 WS** | **Plugin 连 Chat Server WS** |
| **通信方式** | WS 长连接 | WS 长连接 | **WS 长连接** |
| **内网友好？** | ✅ | ✅ | ✅ |
| **Plugin 需要公网IP？** | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 |
| **谁主动** | Plugin 主动连 | Plugin 主动连 | Plugin 主动连 |

---

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
           OpenClaw  OpenClaw  OpenClaw
```

所有 Plugin 都**主动 WS 连接**到公网 Chat Server。浏览器连 Chat Server 后，选择一个 OpenClaw 实例的 agent 对话。Chat Server 根据 pluginId 路由消息。

---

## 领域模型

### 实体定义

| 实体 | 属性 | 职责 |
|------|------|------|
| **User** | userId, userName | 真人用户，通过浏览器与 Agent 对话 |
| **Browser/Tab** | WebSocket, userId, lastSeen | 用户的多设备/多 tab 连接，同一 userId 可有多个 |
| **Chat Server** | browsers{}, plugins{}, agentIndex{} | 全局路由中心，维护所有 WS 连接，按 agentId 路由到对应 Plugin |
| **Plugin Instance** | pluginId, ws, agents[] | 每个 OpenClaw 部署一个 Plugin，主动长连 Chat Server |
| **Agent** | agentId, name, pluginId | 注册在 Plugin 下的 AI 对话代理，全局唯一 agentId |
| **OpenClaw Session** | sessionKey("webchat:{userId}"), history | Core 管理，按用户隔离会话，跨消息持久化 |
| **Message** | type, userId, agentId, content, messageId | 消息载体，在三条路径间流转 |

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
│  │ browsers     │  │ plugins      │  │ agentIndex   │   │
│  │ userId ->    │  │ pluginId ->  │  │ agentId ->   │   │
│  │   Set<WS>    │  │   {ws,agents}│  │   pluginId   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│  路由: browser msg(agentId) → agentIndex               │
│        → pluginId → plugin.ws → {type:"incoming"}    │
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
│    │  agentId   │   │  agentId │   多个 Agent)            │
│    └────────────┘   └──────────┘                           │
│           │                                                │
│  ┌────────▼──────────────────────────┐                    │
│  │  OpenClaw Core Session            │                    │
│  │  sessionKey = "webchat:{userId}"  │                    │
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
- 注册后 Server 返回可用 agent 列表

**Plugin ↔ Chat Server（N:1）**
- 每个 OpenClaw 实例上的 Plugin 主动出站连 Chat Server
- 连接路径：`ws://host/plugin`
- 注册时声明 pluginId + agents[]
- 断线自动重连（指数退避 2s→30s）
- **内网不需要公网 IP**，只要能出站访问 Chat Server 即可

**Agent ↔ Plugin（N:1）**
- 每个 Agent 只属于一个 Plugin（一个 OpenClaw 实例）
- `agentIndex`：`agentId → pluginId`
- 消息路由：browser msg(agentId) → agentIndex[agentId] → plugin WS

⚠️ **agentId 碰撞问题**：两个 Plugin 注册相同的 agentId（如都注册 "nezha"），后注册的会覆盖 agentIndex 记录，前者的消息会丢失。**解决方案**：agentId 全局唯一，或用户在浏览器按 `{pluginId, agentId}` 二元组选择。

**User ↔ Agent（N:M via Session）**
- 用户选不同 Agent 对话，同 Agent 服务不同用户
- 发消息时指定 `agentId`
- Core 按 `sessionKey = "webchat:{userId}"` 管理会话
- 每个 (userId, agentId) 组合有独立对话历史

**Session 生命周期**
```
Browser 第一次发消息
  → Chat Server 路由到 Plugin
  → Plugin dispatchIncoming()
  → finalizeInboundContext(userId, agentId)
  → recordInboundSession()           ← 创建/恢复 Core Session
  → dispatchReplyWithBufferedBlockDispatcher()
  → Agent 处理 → 回复
  → outbound.sendText() → sendOutgoingMessage(userId, content)
  → Chat Server 推送 → Browser
```

- Session 由 Core 按 `channel:chatId` 管理，chatId = userId
- **跨浏览器重启持久化**（Core 保存对话历史）
- **用户间隔离**：不同 userId 的数据互不干扰

### 多实例数据流示例

```
UserA (浏览器tab1) ──┐
UserA (浏览器tab2) ──┤
UserB (浏览器) ──────┤──── Chat Server (:3100)
                     │    ├── agentIndex["nezha"] → "plugin-local"
                     │    ├── agentIndex["cloud"]  → "plugin-cloud"
                     │    └── agentIndex["r2d2"]   → "plugin-cloud"
                     │
         ┌───────────┼───────────┐
         │           │           │
    plugin-local   plugin-cloud  (未来更多)
    agent: nezha    agent: cloud
                    agent: r2d2
```

- UserA 选 "cloud" → 消息发到 Chat Server → agentIndex["cloud"] → 推给 plugin-cloud → dispatch → Core → Agent → 回复原路返回
- UserB 选 "nezha" → 路由到 plugin-local → 回复返回

### 一句话总结

**Chat Server** 是连接路由器（User ↔ Plugin），**Plugin** 是消息转换器（WebSocket ↔ Core dispatch），**Agent** 是消息处理器，**Session** 是对话历史容器。整体架构是把飞书/企微的外部队长连模式嫁接到浏览器场景。

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
