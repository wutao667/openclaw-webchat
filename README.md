# WebChat — 浏览器聊天的 OpenClaw Channel Plugin

通过浏览器直接和你的 OpenClaw Agent 对话。对标飞书/企微 channel，但不需要第三方 IM 平台。

## 架构

```
浏览器 ──WS──→ Chat Server（公网） ──WS──→ Channel Plugin ──dispatch──→ OpenClaw Core → Agent
```

- **Chat Server**: 公网部署的 Node.js 服务，管理浏览器和 Plugin 的 WebSocket 连接
- **Channel Plugin**: 安装在 OpenClaw Gateway 上的插件，主动出站 WS 连接 Chat Server
- **Plugin 主动连 Chat Server**（不是 webhook），内网机器只要有出网能力就能用

## 目录结构

```
webchat3.0/
├── server/                 # Chat Server（需公网部署）
│   ├── server.js           # HTTP + WebSocket 服务
│   ├── package.json
│   └── public/             # 前端静态文件
│       ├── index.html
│       ├── style.css
│       └── app.js
├── plugin/                 # OpenClaw Channel Plugin
│   ├── index.js            # 插件入口
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
│       ├── channel.js      # 频道注册
│       ├── ws-client.js    # WebSocket 客户端 + dispatch 逻辑
│       ├── accounts.js     # 账号配置解析
│       ├── runtime.js      # Runtime Store
│       └── const.js        # 常量
└── README.md
```

---

## 安装使用

### 1. 部署 Chat Server（一次部署，多人共用）

Chat Server 需要有**公网 IP**（或内网穿透），浏览器和 Plugin 都通过它中转。

```bash
# 方式一：通过 npx 一键启动（推荐）
npx openclaw-webchat-server

# 方式二：克隆仓库手动运行
git clone https://github.com/wutao667/openclaw-wechat.git
cd openclaw-wechat/server
npm install
PORT=3100 node server.js
```

Chat Server 启动后：
- `http://<host>:3100` — 前端页面
- `ws://<host>:3100/ws` — 浏览器 WebSocket 端点
- `ws://<host>:3100/plugin` — Plugin WebSocket 端点

> 💡 生产环境建议用 **Caddy** 或 **Nginx** 反代并配置 HTTPS/WSS。

### 2. 安装 Plugin 到 OpenClaw

在每台要接入的 **OpenClaw Gateway 机器** 上操作。

```bash
# 方式一：通过 npm 源安装（推荐）
openclaw plugins install openclaw-webchat-plugin

# 方式二：本地安装（link 模式，开发用）
openclaw plugins install path:/path/to/webchat3.0/plugin

# 查看安装状态
openclaw plugins list
```

### 3. 配置 channel

编辑 OpenClaw 配置（`~/.openclaw/openclaw.json`），添加 openclaw-webchat channel：

```json
{
  "channels": {
    "openclaw-webchat": {
      "enabled": true,
      "serverUrl": "wss://your-domain.com/plugin",
      "pluginId": "openclaw-webchat-plugin",
      "agents": [
        { "agentId": "main", "name": "研发小虾" }
      ],
      "dmPolicy": "open"
    }
  }
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `enabled` | 启用开关 | `true` |
| `serverUrl` | Chat Server 的 `/plugin` WebSocket 地址 | `ws://localhost:3100/plugin` |
| `pluginId` | Plugin ID，和 `openclaw.plugin.json` 一致 | `openclaw-webchat-plugin` |
| `agents` | 暴露给用户的 Agent 列表 | `[{ agentId: "nezha", name: "哪吒" }]` |
| `dmPolicy` | 私聊策略 | `open` |

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

### 5. 打开浏览器

访问 Chat Server 的 HTTP 地址（如 `https://your-domain.com`），输入用户名，选择 Agent，开始聊天。

---

## HTTPS/WSS 配置（Caddy 反代）

Chat Server 本身只监听 HTTP，生产环境用 Caddy 加一层 TLS 反向代理：

```caddy
your-domain.com {
    reverse_proxy localhost:3100
}
```

Caddy 自动申请证书，浏览器通过 `wss://your-domain.com/plugin` 和 `wss://your-domain.com/ws` 连接。

Plugin 的 `serverUrl` 配置为 `wss://your-domain.com/plugin`。

---

## 多 OpenClaw 实例接入

多个 OpenClaw 实例各自安装 Plugin，分别配置不同的 `agentId`，都连到同一个 Chat Server：

```json
// 实例 A 的配置
{ "agents": [{ "agentId": "instance-a", "name": "A 机器" }] }

// 实例 B 的配置
{ "agents": [{ "agentId": "instance-b", "name": "B 机器" }] }
```

浏览器端会看到两个 Agent，消息按 `agentId` 路由到对应实例。

---

## Session 模型

- `sessionKey = openclaw-webchat:{userId}:{agentId}` — 按用户+Agent 隔离会话
- 同一用户在不同浏览器登录同一个 Agent，共享会话历史
- 不同用户之间的会话完全隔离
- 服务端内存保留最近 100 条消息

---

## 验证

Chat Server 启动后，访问 `/healthz` 查看状态：

```bash
curl http://localhost:3100/healthz
# {"ok":true}
```

或者用内置的测试脚本：

```bash
cd server && node test-ws.mjs
```

---

## 开发

```bash
# Chat Server 开发启动
cd server && npm run dev

# Plugin 源码在 plugin/src/，修改后需要重启 Gateway 生效
# 或使用 link 安装模式，改完重载
```

---

## 常见问题

**Q: Plugin 启动报 "channel registration missing id"**

A: 检查 `plugin/src/channel.js`，`id: CHANNEL_ID` 必须在 `webchatPlugin` 对象的顶层，不在 `meta` 内部。

**Q: Agent 回复 "No API key found for provider"**

A: Plugin dispatch 链需要读取完整的 OpenClaw 配置才能获取模型信息。确保 `ws-client.js` 有 `loadGatewayConfig()` 从磁盘读取配置。

**Q: Plugin 连接后又断开（启动循环）**

A: `startAccount` 需要返回长生命周期 promise（`alivePromise`），否则 Gateway 认为通道启动完成就退出了。
