import { DEFAULT_ACCOUNT_ID, DEFAULT_SERVER_URL } from "./const.js";

export function baseConfig(section = {}) {
  const { accounts, ...base } = section || {};
  return base;
}

export function mergeAccountConfig(base = {}, account = {}) {
  return {
    ...base,
    ...account,
    headers: {
      ...(base.headers || {}),
      ...(account.headers || {}),
    },
  };
}

export function getWebChatConfig(cfg) {
  if (!cfg) return {};
  // Full config: openclaw.json with channels["openclaw-webchat"]
  if (cfg.channels?.["openclaw-webchat"]) return cfg.channels["openclaw-webchat"];
  // Channel section: already at channels["openclaw-webchat"] level
  if (cfg.serverUrl || cfg.accounts) return cfg;
  // Account-level config (Gateway strips unknown fields, only passes appId+secret)
  if (cfg.appId) return cfg;
  return {};
}

export function listWebChatAccountIds(cfg) {
  const section = getWebChatConfig(cfg);
  const ids = Object.keys(section.accounts || {}).filter(Boolean);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function getDefaultWebChatAccountId(cfg) {
  const ids = listWebChatAccountIds(cfg);
  return ids[0] || DEFAULT_ACCOUNT_ID;
}

export function getWebChatAccount(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const section = getWebChatConfig(cfg);
  const base = baseConfig(section);
  const accountMap = section.accounts || {};
  const selectedAccountId = accountId || getDefaultWebChatAccountId(cfg);
  const accountOverride = accountMap[selectedAccountId] || {};
  const merged = mergeAccountConfig(base, accountOverride);
  const appId = merged.appId || "";
  const secret = merged.secret || "";
  const serverUrl = merged.serverUrl || DEFAULT_SERVER_URL;
  const configured = Boolean(serverUrl && appId && secret);

  return {
    accountId: selectedAccountId,
    enabled: merged.enabled !== false,
    configured,
    appId,
    secret,
    serverUrl,
    allowFrom: merged.allowFrom || ["*"],
    dmPolicy: merged.dmPolicy || "open",
    config: merged,
  };
}

export function getWebChatCredentials(account) {
  if (!account) return null;
  const { appId, secret } = account;
  if (!appId || !secret) return null;
  return { appId, secret };
}

export function isConfigured(account) {
  return Boolean(account?.serverUrl && account?.appId && account?.secret);
}
