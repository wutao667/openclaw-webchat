import { CHANNEL_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import { startWebChatWsClient, stopWebChatWsClient, sendOutgoingMessage } from "./ws-client.js";
import { listWebChatAccountIds, resolveWebChatAccount, resolveDefaultWebChatAccountId } from "./accounts.js";
import { getWebChatRuntime } from "./runtime.js";

export const webchatPlugin = {
  id: CHANNEL_ID,
  meta: {
    label: "WebChat",
    selectionLabel: "WebChat",
    blurb: "Browser chat channel for OpenClaw",
  },

  capabilities: {
    blockStreaming: true,
    directChatOnly: true,
  },

  config: {
    listAccountIds: listWebChatAccountIds,
    resolveAccount: async ({ cfg, accountId }) => resolveWebChatAccount(cfg, accountId),
    isConfigured: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      return account.enabled;
    },
    describeAccount: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      return {
        label: CHANNEL_ID,
        description: "WebChat channel",
        configured: account.enabled,
        inbound: true,
        outbound: true,
      };
    },
    resolveAllowFrom: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      return { allowFrom: account.allowFrom };
    },
  },

  security: {
    resolveDmPolicy: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      return account.dmPolicy;
    },
  },

  messaging: {
    normalizeTarget: async ({ to }) => {
      return { target: to };
    },
    targetResolver: async ({ to }) => {
      const result = { targets: [{ to, chatId: to }] };
      return result;
    },
  },

  outbound: {
    deliveryMode: "gateway",
    chunker: (text, limit) => getWebChatRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId, cfg }) => {
      return sendOutgoingMessage({ to, text, accountId, cfg });
    },
  },

  status: {
    defaultRuntime: async ({ cfg }) => {
      return {
        accountId: resolveDefaultWebChatAccountId(cfg),
        status: "starting",
      };
    },
    collectStatusIssues: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      const issues = [];
      if (!account.enabled) {
        issues.push({ kind: "warning", message: "WebChat channel is disabled" });
      }
      return issues;
    },
    buildChannelSummary: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      return { label: CHANNEL_ID, summary: `WebChat: ${account.serverUrl}` };
    },
  },

  gateway: {
    startAccount: async ({ cfg, accountId }) => {
      const account = resolveWebChatAccount(cfg, accountId);
      const runtime = getWebChatRuntime();
      startWebChatWsClient(runtime, account);
      return { accountId };
    },
    logoutAccount: async ({ cfg, accountId }) => {
      stopWebChatWsClient();
      return { accountId };
    },
  },
};
