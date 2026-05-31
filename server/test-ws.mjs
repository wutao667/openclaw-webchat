import WebSocket from "ws";

const WS_URL = "ws://localhost:3100/ws";
const ws = new WebSocket(WS_URL);

let testUser = "testuser";

ws.on("open", () => {
  console.log("--- Connected ---");
  ws.send(JSON.stringify({ type: "register", userId: testUser }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === "registered") {
    console.log("RECV: registered as", msg.userId);
  } else if (msg.type === "agent_list") {
    console.log("RECV: agents:", JSON.stringify(msg.agents));
    // Send a test message to the first agent
    const target = msg.agents?.[0];
    if (target) {
      console.log(`\n=== Sending message to agent ${target.agentId} ===`);
      ws.send(JSON.stringify({
        type: "message",
        userId: testUser,
        userName: "TestUser",
        agentId: target.agentId,
        content: "你好，测试消息"
      }));
    }
  } else if (msg.type === "history") {
    const msgs = msg.messages?.main || [];
    const last = msgs[msgs.length - 1];
    if (last) {
      const agentReply = last.role === "agent" ? last.content : "no agent reply found";
      console.log("RECV history last:", agentReply.substring(0, 200));
    }
  } else if (msg.type === "message") {
    console.log("RECV message:", msg.content.substring(0, 300));
    console.log("\n=== Reply received! ===\n");
    ws.close();
    process.exit(0);
  } else if (msg.type === "error") {
    console.log("RECV error:", msg.content);
    ws.close();
    process.exit(1);
  }
});

setTimeout(() => {
  console.log("TIMEOUT - no response");
  ws.close();
  process.exit(1);
}, 20000);
