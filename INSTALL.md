# WebChat 安装接入指南

> 让 OpenClaw 多一个浏览器聊天入口，用户在网页上就能和 Agent 聊天。

## 架构

```
浏览器 ──WS── Chat Server(:3100) ──WS── OpenClaw Plugin ──dispatch── Agent
              ↑ Caddy HTTPS 反代           ↑ Plugin 主动出站连接
```

- **Chat Server**：轻量 Node.js WebSocket 服务器
- **Plugin**：安装到 OpenClaw Gateway 上的 Channel Plugin
- 只需要 Server 有公网域名，Plugin 内网就能跑

## 安装步骤

### 1. 装 Chat Server（任意有公网域名的机器）

```bash
npx openclaw-webchat-server
```

默认监听 `http://localhost:3100`。

配 Caddy 加 TLS 反代：

```caddy
test.huaguo.site {
    reverse_proxy localhost:3100
}
```

重启 Caddy 后验证：

```bash
curl https://test.huaguo.site/healthz
# 返回 {"ok":true}
```

### 2. 创建 Agent 身份（apps.json）

在 Chat Server 同目录创建 `apps.json`：

```bash
# 生成 bcrypt 哈希
node -e "const b=require('bcryptjs');console.log(b.hashSync('你的密钥',10))"
```

把结果填进去：

```json
{
  "adminPassword": "$2b$10$...",
  "apps": {
    "wch_myagent": {
      "secretHash": "$2b$10$...",
      "name": "我的Agent昵称",
      "enabled": true
    }
  }
}
```

> `appId` 格式 `wch_` + 16 位 hex（如 `wch_a1b2c3d4e5f60708`），`secret` 随意。

保存后重启 Chat Server。

### 3. 安装 Plugin（Gateway 机器上）

```bash
openclaw plugins install openclaw-webchat-plugin
```

### 4. 配置 openclaw.json

在 Gateway 的 `channels` 段加：

```json
"openclaw-webchat": {
    "enabled": true,
    "serverUrl": "wss://test.huaguo.site/plugin",
    "accounts": {
        "my-account": {
            "appId": "wch_myagent",
            "secret": "你的密钥"
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
```

> `serverUrl` 只放 channel 层，account 里不要重复。

### 5. 重启 Gateway

```bash
openclaw gateway restart
```

### 6. 验证

```bash
openclaw channels list
```

期望输出：

```
- WebChat my-account: installed, configured, enabled
```

### 7. 打开浏览器

访问 `https://test.huaguo.site`，输入任意用户名就能聊了。

## 多 Agent

同一个 Gateway 接多个 Agent，只需加 account：

```json
"accounts": {
    "dev": {
        "appId": "wch_dev",
        "secret": "sk-dev-xxx"
    },
    "prod": {
        "appId": "wch_prod", 
        "secret": "sk-prod-xxx"
    }
}
```

Server 端 `apps.json` 也注册对应的 appId，浏览器登录后就能看到多个 Agent 可选。

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `not configured` | serverUrl 被 Gateway 过滤 | 检查 `openclaw.plugin.json` 里 account schema 是否有 `serverUrl` |
| `channel exited without an error` | 缺 alivePromise | 升级到 v0.2.0+ |
| `invalid_app` / `invalid_secret` | apps.json 和配置不匹配 | 检查 bcrypt hash 是否正确 |
| 浏览器连不上 | Caddy TLS 或端口问题 | 检查 healthz 是否 200 |
