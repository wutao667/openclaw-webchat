import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { webchatPlugin } from "./src/channel.js";
import { setWebChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "openclaw-webchat-plugin",
  name: "WebChat",
  description: "Browser WebChat channel for OpenClaw",
  configSchema: emptyPluginConfigSchema(),

  register(api) {
    setWebChatRuntime(api.runtime);
    api.registerChannel({ plugin: webchatPlugin });
  },
};

export default plugin;
