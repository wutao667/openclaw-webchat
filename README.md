# WebChat - 浏览器聊天的 OpenClaw Channel Plugin

通过浏览器直接和你的 OpenClaw Agent 对话。对标飞书/企微 channel，但不需要第三方 IM 平台。

## 架构

```
浏览器 --WS--> Chat Server（公网） --WS--> Channel Plugin --dispatch--> OpenClaw Core -> Agent
```

## 截图预览

### 登录页

![Login](docs/screenshots/01-login.png)

### 聊天列表（Agent 列表）

![Agent list](docs/screenshots/02-agent-list.png)

### 聊天页（Agent 正在回复，typing indicator）

![Chat](docs/screenshots/03-chat.png)

### 管理后台（Admin Dashboard）

Admin 入口：`/admin/`，默认密码 `admin`（首次登录后请立即修改）。

![Admin](docs/screenshots/04-admin.png)

- **Chat Server**: 公网部署的 Node.js 服务，管理浏览器和 Plugin 的 WebSocket 连接
- **Channel Plugin**: 安装在 OpenClaw Gateway 上的插件，主动出站 WS 连接 Chat Server
- **Plugin 主动连 Chat Server**（不是 webhook），内网机器只要有出网能力就能用

## 目录结构

```
webchat3.0/
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   └── IMPL-GUIDE.md
├── server/                 # Chat Server（需公网部署）
│   ├── server.js           # HTTP + WebSocket 服务
│   ├── package.json
│   ├── README.md           # server npm 包文档
│   └── public/             # 前端静态文件
│       ├── index.html
│       ├── style.css
│       └── app.js
└── plugin/                 # OpenClaw Channel Plugin
    ├── index.js            # 插件入口
    ├── openclaw.plugin.json
    ├── package.json
    ├── README.md           # plugin npm 包文档
    └── src/
        ├── channel.js      # 频道注册
        ├── ws-client.js    # WebSocket 客户端 + dispatch 逻辑
        ├── accounts.js     # 账号配置解析
        ├── runtime.js      # Runtime Store
        └── const.js        # 常量
```

---

## 安装使用

### 1. 部署 Chat Server

Chat Server 需要有公网 IP 或公网域名。浏览器和 Plugin 都通过它中转。

```bash
# 方式一：通过 npx 一键启动（推荐）
npx openclaw-webchat-server

# 方式二：克隆仓库手动运行
git clone https://github.com/wutao667/openclaw-webchat.git
cd openclaw-webchat/server
npm install
PORT=3100 node server.js
```

默认监听 `http://localhost:3100`。

Chat Server 启动后：

- `http://<host>:3100` - 前端页面
- `ws://<host>:3100/ws` - 浏览器 WebSocket 端点
- `ws://<host>:3100/plugin` - Plugin WebSocket 端点

### 2. 配置 HTTPS/WSS

生产环境建议用 Caddy 或 Nginx 反代并配置 HTTPS/WSS。Caddy 示例：

```caddy
your-domain.com {
    reverse_proxy localhost:3100
}
```

Caddy 自动申请证书，浏览器通过 `wss://your-domain.com/ws` 连接，Plugin 的 `serverUrl` 配置为 `wss://your-domain.com/plugin`。

重启 Caddy 后验证：

```bash
curl https://your-domain.com/healthz
# {"ok":true}
```

### 3. 创建 Agent 身份

在 Chat Server 同目录创建 `apps.json`。先生成 bcrypt hash：

```bash
node -e "const b=require('bcryptjs');console.log(b.hashSync('你的密钥',10))"
```

把结果填进 `apps.json`：

```json
{
  "adminPassword": "$2b$10$...",
  "apps": {
    "wch_a1b2c3d4e5f60708": {
      "secretHash": "$2b$10$...",
      "name": "我的Agent昵称",
      "enabled": true
    }
  }
}
```

`appId` 建议使用 `wch_` + 16 位 hex，例如 `wch_a1b2c3d4e5f60708`。`secret` 是 Plugin 侧配置的明文密钥，Server 只保存 `secretHash`。

保存后重启 Chat Server。

### 4. 安装 Plugin

在每台要接入的 OpenClaw Gateway 机器上操作。

```bash
# 方式一：通过 npm 源安装（推荐）
openclaw plugins install openclaw-webchat-plugin

# 方式二：本地安装（link 模式，开发用）
openclaw plugins install path:/path/to/webchat3.0/plugin

# 查看安装状态
openclaw plugins list
```

### 5. 配置 openclaw.json

编辑 OpenClaw 配置（`~/.openclaw/openclaw.json`），添加 channel accounts 和全局 bindings：

```json
{
  "channels": {
    "openclaw-webchat": {
      "enabled": true,
      "serverUrl": "wss://your-domain.com/plugin",
      "accounts": {
        "my-account": {
          "appId": "wch_a1b2c3d4e5f60708",
          "secret": "你的密钥"
        }
      }
    }
  },
  "bindings": [
    {
      "channel": "openclaw-webchat",
      "accountId": "my-account",
      "agentId": "main"
    }
  ]
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `enabled` | 启用开关 | `true` |
| `serverUrl` | Chat Server 的 `/plugin` WebSocket 地址，只放 channel 层 | `ws://localhost:3100/plugin` |
| `accounts` | Plugin 侧账号配置，每个 account 对应 Server 端一个 App | `{}` |
| `accounts.*.appId` | Server 端 `apps.json` 注册的 App ID | 无 |
| `accounts.*.secret` | 与 `apps.json` 中 `secretHash` 匹配的明文密钥 | 无 |
| `bindings` | 将 `{ channel, accountId }` 绑定到 OpenClaw `agentId` | 无 |

### 6. 重启 Gateway

```bash
openclaw gateway restart
```

重启后验证 channel 状态：

```bash
openclaw channels list
```

期望看到类似输出：

```text
- WebChat my-account: installed, configured, enabled
```

### 7. 打开浏览器

访问 Chat Server 的 HTTP 地址（如 `https://your-domain.com`），输入用户名，选择 Agent，开始聊天。

---

## 多 Agent

同一个 Gateway 接多个 Agent，只需加 account，并在 Server 端 `apps.json` 注册对应的 `appId`：

```json
{
  "channels": {
    "openclaw-webchat": {
      "enabled": true,
      "serverUrl": "wss://your-domain.com/plugin",
      "accounts": {
        "dev": {
          "appId": "wch_dev0000000000000",
          "secret": "sk-dev-xxx"
        },
        "prod": {
          "appId": "wch_prod000000000000",
          "secret": "sk-prod-xxx"
        }
      }
    }
  },
  "bindings": [
    {
      "channel": "openclaw-webchat",
      "accountId": "dev",
      "agentId": "dev-agent"
    },
    {
      "channel": "openclaw-webchat",
      "accountId": "prod",
      "agentId": "prod-agent"
    }
  ]
}
```

浏览器端会看到多个 Agent，消息按 `appId` 路由到对应 Plugin 连接，再由 Plugin 根据 `bindings` 分发给对应 `agentId`。

多个 OpenClaw 实例也可以连接到同一个 Chat Server：每个实例安装 Plugin，配置自己的 account、`appId`、`secret` 和 `bindings` 即可。

---

## Session 模型

- `sessionKey = openclaw-webchat:{userId}:{agentId}` - 按用户+Agent 隔离会话
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
cd server
node test-ws.mjs
```

---

## 开发

```bash
# Chat Server 开发启动
cd server
npm run dev

# Plugin 源码在 plugin/src/，修改后需要重启 Gateway 生效
# 或使用 link 安装模式，改完重载
```

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `not configured` | OpenClaw 没读到 WebChat account 配置，或 `serverUrl`/account 字段被 schema 过滤 | 检查 `openclaw.json` 使用 `accounts` + `bindings`，并确认 `serverUrl` 放在 channel 层 |
| `invalid_app` | Plugin 上报的 `appId` 不存在或已禁用 | 检查 Chat Server 同目录 `apps.json` 是否注册该 `appId`，且 `enabled` 不是 `false` |
| `invalid_secret` | Plugin 配置的 `secret` 与 Server 端 `secretHash` 不匹配 | 重新用 bcrypt 生成 hash，确认明文 secret 和 hash 对应 |
| `channel exited without an error` | 旧版本缺少长生命周期 `alivePromise` | 升级到 v0.2.0+ |
| 浏览器连不上 | Caddy TLS、域名或端口问题 | 先检查 `/healthz` 是否返回 200，再检查浏览器控制台 WebSocket 地址 |
| Plugin 启动报 `channel registration missing id` | channel 注册对象缺少顶层 `id` | 检查 `plugin/src/channel.js`，`id: CHANNEL_ID` 必须在 `webchatPlugin` 对象的顶层，不在 `meta` 内部 |
| Agent 回复 `No API key found for provider` | Plugin dispatch 链没有读取完整 OpenClaw 配置 | 确保 Plugin 能从 Gateway 配置读取模型 provider/API key |
| Plugin 连接后又断开（启动循环） | 通道启动函数过早结束 | `startAccount` 需要返回长生命周期 promise（`alivePromise`） |
