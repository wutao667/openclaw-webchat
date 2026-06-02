import fs from "fs";
import path from "path";
import os from "os";
import { WebSocket } from "ws";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./const.js";
import { getWebChatRuntime } from "./runtime.js";
import { getWebChatAccount } from "./accounts.js";

const clients = new Map();

function loadGatewayConfig() {
  try {
    const configPath = path.resolve(os.homedir(), ".openclaw/openclaw.json");
    const content = fs.readFileSync(configPath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    console.warn("[webchat] could not load gateway config:", err.message);
    return {};
  }
}

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
  const userId = String(message.userId || "");
  const conversationId = String(message.conversationId || userId);
  const content = String(message.content || "");

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: conversationId,
    },
  });

  const agentId = route.agentId;
  if (!agentId) {
    throw new Error(`No agent binding found for ${CHANNEL_ID}/${account.accountId}`);
  }

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId,
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
    AccountId: account.accountId,
    ChatType: "direct",
    ConversationLabel: `user:${String(message.userName || userId)}`,
    Timestamp: Date.now(),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${conversationId}`,
    CommandAuthorized: true,
    WebChatMessage: message,
    AgentId: agentId,
  });

  return {
    core,
    route,
    storePath,
    ctxPayload,
    userId,
    conversationId,
    agentId,
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
    agentId,
  } = buildInboundContext({ message, account, cfg });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey || route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey || route.sessionKey,
      channel: CHANNEL_ID,
      to: `${CHANNEL_ID}:${conversationId}`,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      runtime?.error?.(`[webchat] failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      onReplyStart: async () => {
        runtime?.log?.(`[webchat] reply started user=${userId} agent=${agentId}`);
      },
      deliver: async (payload) => {
        const text = payload.text || "";
        if (!text) return;

        await sendOutgoingMessage({
          to: `${CHANNEL_ID}:${userId}`,
          text,
          accountId: account.accountId,
          cfg,
        });
      },
      onError: (err, info) => {
        runtime?.error?.(`[webchat] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

function scheduleReconnect(state) {
  if (state.intentionalClose || state.reconnectTimer || state.abortSignal?.aborted) return;
  if (state.authFailed) return;

  state.reconnectAttempts += 1;
  const delay = Math.min(30_000, Math.max(2_000, 2 ** state.reconnectAttempts * 1_000));

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWithReconnect(state);
  }, delay);
}

function connectWithReconnect(state) {
  const { account, runtime, abortSignal, setStatus } = state;
  if (!account?.serverUrl || abortSignal?.aborted) return;

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  const ws = new WebSocket(account.serverUrl);
  state.ws = ws;
  state.connected = false;

  ws.on("open", () => {
    state.connected = true;
    state.authFailed = false;
    state.reconnectAttempts = 0;

    sendJson(ws, {
      type: "register",
      appId: account.appId,
      secret: account.secret,
    });

    state.heartbeatTimer = setInterval(() => {
      sendJson(ws, {
        type: "ping",
        ts: Date.now(),
      });
    }, 30_000);

    setStatus?.({
      accountId: account.accountId,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });
  });

  ws.on("message", async (raw) => {
    const message = parseJson(raw);

    if (!message?.type) {
      runtime?.error?.("[webchat] invalid message from server");
      return;
    }

    if (message.type === "registered") {
      runtime?.log?.("[webchat] registered with chat server");
      return;
    }

    if (message.type === "register_error") {
      state.authFailed = true;
      setStatus?.({
        accountId: account.accountId,
        running: false,
        lastError: message.error || "registration_failed",
      });
      ws.close();
      return;
    }

    if (message.type === "pong") {
      state.lastPongAt = Date.now();
      return;
    }

    if (message.type === "app_list") {
      runtime?.log?.(`[webchat] app list received ${JSON.stringify(message.apps || [])}`);
      return;
    }

    if (message.type === "incoming") {
      if (message.appId !== account.appId) {
        runtime?.error?.(
          `[webchat] ignored incoming for appId=${message.appId}, expected=${account.appId}`,
        );
        return;
      }

      try {
        await dispatchIncoming({
          message,
          account,
          cfg: state.cfg,
          runtime,
        });
      } catch (err) {
        runtime?.error?.(`[webchat] failed to dispatch incoming message ${String(err)}`);
      }
      return;
    }

    if (message.type === "delivery_ack") {
      runtime?.log?.(`[webchat] delivery ack ${JSON.stringify(message)}`);
      return;
    }

    if (message.type === "error") {
      runtime?.error?.(`[webchat] server error ${JSON.stringify(message)}`);
    }
  });

  ws.on("close", () => {
    if (state.ws === ws) {
      state.ws = null;
    }

    state.connected = false;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }

    setStatus?.({
      accountId: account.accountId,
      running: false,
      lastStopAt: Date.now(),
    });

    scheduleReconnect(state);
  });

  ws.on("error", (err) => {
    runtime?.error?.(`[webchat] websocket error ${String(err.message || err)}`);
    setStatus?.({
      accountId: account.accountId,
      running: false,
      lastError: String(err.message || err),
    });
    ws.close();
  });
}

export async function startWebChatWsClient({
  runtime,
  account,
  cfg,
  abortSignal,
  setStatus,
}) {
  const fullCfg = cfg || loadGatewayConfig();
  const state = {
    ws: null,
    runtime: runtime || getWebChatRuntime(),
    account,
    cfg: fullCfg,
    reconnectTimer: null,
    heartbeatTimer: null,
    reconnectAttempts: 0,
    intentionalClose: false,
    connected: false,
    authFailed: false,
    abortSignal,
    setStatus,
    lastPongAt: null,
    aliveResolve: null,
  };

  // Stop previous client if replacing (config reload/restart)
  const existing = clients.get(account.accountId);
  if (existing) {
    stopWebChatWsClient(account.accountId);
  }

  clients.set(account.accountId, state);

  if (abortSignal) {
    abortSignal.addEventListener(
      "abort",
      async () => {
        await stopWebChatWsClient(account.accountId);
      },
      { once: true },
    );
  }

  // alivePromise keeps the channel alive as long as reconnection is possible
  const alivePromise = new Promise((resolve) => {
    state.aliveResolve = resolve;
  });

  connectWithReconnect(state);

  return alivePromise;
}

export async function stopWebChatWsClient(accountId = DEFAULT_ACCOUNT_ID) {
  const state = clients.get(accountId);
  if (!state) return;

  clients.delete(accountId);
  state.intentionalClose = true;

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  // Resolve alivePromise so startAccount completes
  state.aliveResolve?.();
}

export function sendOutgoingMessage({ to, text, accountId = DEFAULT_ACCOUNT_ID, cfg }) {
  let state = clients.get(accountId);

  if (!state && cfg) {
    const account = getWebChatAccount(cfg, accountId);
    state = clients.get(account.accountId);
  }

  const userId = stripChannelPrefix(to);
  const messageId = `webchat_out_${Date.now()}`;

  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`WebChat websocket is not connected for account ${accountId}`);
  }

  sendJson(state.ws, {
    type: "outgoing",
    appId: state.account.appId,
    userId,
    conversationId: userId,
    content: text,
    messageId,
  });

  return { channel: CHANNEL_ID, messageId, chatId: userId };
}
