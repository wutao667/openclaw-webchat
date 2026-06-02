import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import { startWebChatWsClient, stopWebChatWsClient, sendOutgoingMessage } from "./ws-client.js";
import {
  listWebChatAccountIds,
  getWebChatAccount,
  getDefaultWebChatAccountId,
  isConfigured,
} from "./accounts.js";
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

  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`],
  },

  config: {
    listAccountIds: listWebChatAccountIds,
    resolveAccount: (cfg, accountId) => getWebChatAccount(cfg, accountId),
    defaultAccountId: (cfg) => getDefaultWebChatAccountId(cfg),
    isConfigured: (account, cfg) => Boolean(account?.serverUrl && account?.appId && account?.secret),
    describeAccount: (account, cfg) => ({
      accountId: account.accountId,
      label: CHANNEL_ID,
      description: "WebChat channel",
      configured: Boolean(account.serverUrl && account.appId && account.secret),
      inbound: true,
      outbound: true,
      serverUrl: account.serverUrl,
      appId: account.appId,
    }),
    resolveAllowFrom: async ({ cfg, accountId }) => {
      const resolvedAccount = getWebChatAccount(cfg, accountId);
      return { allowFrom: resolvedAccount.allowFrom };
    },
  },

  security: {
    resolveDmPolicy: async ({ cfg, accountId, account }) => {
      const resolvedAccount = account || getWebChatAccount(cfg, accountId);
      return resolvedAccount.dmPolicy;
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

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
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
        accountId: getDefaultWebChatAccountId(cfg),
        status: "starting",
      };
    },
    collectStatusIssues: async ({ cfg, accountId, accounts }) => {
      const entries = Array.isArray(accounts) ? accounts : [getWebChatAccount(cfg, accountId)];
      const issues = [];

      for (const account of entries) {
        if (account.enabled === false) continue;

        if (!isConfigured(account)) {
          issues.push({
            kind: "warning",
            message: "WebChat account is missing serverUrl, appId, or secret",
            fix: "Set channels.openclaw-webchat.serverUrl and channels.openclaw-webchat.accounts.<accountId>.appId/secret",
          });
        }
      }

      return issues;
    },
    buildChannelSummary: async ({ cfg, accountId }) => {
      const account = getWebChatAccount(cfg, accountId);
      return { label: CHANNEL_ID, summary: `WebChat: ${account.serverUrl}` };
    },
  },

  gateway: {
    startAccount: async ({ cfg, accountId, runtime, abortSignal, setStatus }) => {
      const account = getWebChatAccount(cfg, accountId);
      await startWebChatWsClient({
        runtime: runtime || getWebChatRuntime(),
        account,
        cfg,
        abortSignal,
        setStatus,
      });
      return { accountId: account.accountId };
    },
    logoutAccount: async (ctx = {}) => {
      const account = getWebChatAccount(ctx.cfg || {}, ctx.accountId || DEFAULT_ACCOUNT_ID);
      await stopWebChatWsClient(account.accountId);
      return { accountId: account.accountId };
    },
  },
};
