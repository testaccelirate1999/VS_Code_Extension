// src/extension.ts
import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";
import { ServerManager } from "./serverManager";

let serverManager: ServerManager;

export function activate(context: vscode.ExtensionContext) {
  console.log("[DevAgent] Extension activating");

  serverManager = new ServerManager(context);

  // ── Register the sidebar WebviewViewProvider ───────────────────────────────
  // This is what makes the activity-bar icon open/reopen the panel reliably.
  // VS Code calls resolveWebviewView() automatically whenever the view becomes
  // visible — first open, after close, after a window reload.
  const chatPanel = new ChatPanel(context, serverManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanel.VIEW_ID,   // must match the "id" in package.json views entry
      chatPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("devAgent.openChat", () => {
      // Focus the sidebar view (works whether it's already open or collapsed)
      vscode.commands.executeCommand("devAgent.chatView.focus");
    }),

    vscode.commands.registerCommand("devAgent.newSession", async () => {
      const name = await vscode.window.showInputBox({
        prompt:      "Project name (e.g. Orders API)",
        placeHolder: "My API",
      });
      if (name) {
        vscode.commands.executeCommand("devAgent.chatView.focus");
        ChatPanel.current?.startNewSession(name);
      }
    })
  );

  // ── Server polling ─────────────────────────────────────────────────────────
  serverManager.checkAndNotify();
  serverManager.startPolling(15000);
}

export function deactivate() {
  serverManager?.stop();
}