// src/extension.ts
import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";
import { ServerManager } from "./serverManager";

let serverManager: ServerManager;

export function activate(context: vscode.ExtensionContext) {
  console.log("[DevAgent] Extension activating");

  serverManager = new ServerManager(context);

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devAgent.openChat", () => {
      ChatPanel.createOrShow(context, serverManager);
    }),

    vscode.commands.registerCommand("devAgent.newSession", async () => {
      const name = await vscode.window.showInputBox({
        prompt:      "Project name (e.g. Orders API)",
        placeHolder: "My API",
      });
      if (name) {
        ChatPanel.createOrShow(context, serverManager);
        ChatPanel.current?.startNewSession(name);
      }
    })
  );

  // ── Open chat panel ────────────────────────────────────────────────────────
  ChatPanel.createOrShow(context, serverManager);

  // ── Check server is reachable, then poll every 15s ────────────────────────
  serverManager.checkAndNotify();
  serverManager.startPolling(15000);
}

export function deactivate() {
  serverManager?.stop();
}