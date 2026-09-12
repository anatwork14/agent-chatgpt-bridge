#!/usr/bin/env bun
import { parseArgs } from "util";
import { startServer } from "../server"; // or custom start
import { createBridgeApi } from "../protocols/rest/routes";
import { SessionManager } from "../core/session-manager";
import { SessionStore } from "../persistence/session-store";
import { MessageStore } from "../persistence/message-store";
import { TurnStore } from "../persistence/turn-store";
import { initDatabase } from "../persistence/database";
import { FakeConversationProvider } from "../providers/fake/provider";
import { serve } from "@hono/node-server";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "serve") {
    initDatabase();
    const sm = new SessionManager(new SessionStore(), new MessageStore(), new TurnStore(), {
      "chatgpt-web": new FakeConversationProvider(), // For testing, real one later
    });
    const app = createBridgeApi(sm);
    const port = 8765;
    serve({ fetch: app.fetch, port });
    console.log(`Server started on http://127.0.0.1:${port}`);
    return;
  }

  if (command === "session") {
    const sub = args[1];
    if (sub === "create") {
      const res = await fetch("http://127.0.0.1:8765/bridge/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: args[2] || "default" })
      });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } else if (sub === "list") {
      const res = await fetch("http://127.0.0.1:8765/bridge/v1/sessions");
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (command === "ask") {
    const sessionIndex = args.indexOf("--session");
    const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "default"; // Simplified
    let prompt = args[args.length - 1];
    if (prompt === "--stdin") {
        // Read from stdin
        const chunks = [];
        for await (const chunk of Bun.stdin.stream()) {
            chunks.push(Buffer.from(chunk));
        }
        prompt = Buffer.concat(chunks).toString();
    }
    const res = await fetch(`http://127.0.0.1:8765/bridge/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: prompt }],
        stream: false
      })
    });
    const data = await res.json();
    if (args.includes("--json")) {
        console.log(JSON.stringify(data, null, 2));
    } else {
        console.log(data.message?.content[0]?.text || data);
    }
    return;
  }

  console.log("Usage: agent-chatgpt <serve|session|ask|doctor|run|app>");
}

main().catch(console.error);
