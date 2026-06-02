import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

export const CHANNEL_ID = "openclaw-webchat";
export { DEFAULT_ACCOUNT_ID };

export const DEFAULT_SERVER_URL = process.env.WEBCHAT_SERVER_URL || "ws://localhost:3100/plugin";
export const TEXT_CHUNK_LIMIT = 3500;
