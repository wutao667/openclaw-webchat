# openclaw-webchat-server

WebChat Chat Server for OpenClaw — a WebSocket relay server that connects browsers to OpenClaw agents via the WebChat channel plugin.

## Quick Start

```bash
npx openclaw-webchat-server
```

Server starts on `http://localhost:3100`:
- `http://localhost:3100` — browser chat UI
- `ws://localhost:3100/ws` — browser WebSocket endpoint
- `ws://localhost:3100/plugin` — plugin WebSocket endpoint

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT`              | `3100`  | HTTP/WebSocket server port |

## Production

Use Caddy / Nginx as a TLS reverse proxy for WSS support:

```caddy
your-domain.com {
    reverse_proxy localhost:3100
}
```

## Usage with openclaw-webchat-plugin

1. Deploy this server on a machine with a public IP
2. Install the plugin on your OpenClaw Gateway:

   ```bash
   openclaw plugins install openclaw-webchat-plugin
   ```

3. Configure `~/.openclaw/openclaw.json`:

   ```json
   {
     "channels": {
       "openclaw-webchat": {
         "enabled": true,
         "serverUrl": "wss://your-domain.com/plugin",
         "agents": [
           { "agentId": "main", "name": "我的助手" }
         ]
       }
     }
   }
   ```

4. Restart OpenClaw Gateway and open the browser UI.

## Architecture

```
Browser ──WS──→ Chat Server (public) ──WS──→ Plugin ──dispatch──→ OpenClaw Core → Agent
```

## License

MIT
