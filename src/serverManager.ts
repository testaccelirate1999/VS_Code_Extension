// src/serverManager.ts
import * as vscode from "vscode";
import * as http from "http";

export class ServerManager {
  private _onStatusChange = new vscode.EventEmitter<string>();
  readonly onStatusChange = this._onStatusChange.event;
  private _status: "stopped" | "starting" | "running" | "error" = "stopped";

  constructor(private context: vscode.ExtensionContext) {}

  get status() {
    return this._status;
  }

  get serverUrl(): string {
    return vscode.workspace
      .getConfiguration("devAgent")
      .get("serverUrl", "http://localhost:8001");
  }

  // ── Check server and update status badge ──────────────────────────────────

  async checkAndNotify() {
    const alive = await this._ping();
    if (alive) {
      this._setStatus("running");
    } else {
      this._setStatus("stopped");
      vscode.window
        .showWarningMessage(
          `Dev Agent: Server not reachable at ${this.serverUrl}. ` +
          `Start it with: python server.py`,
          "How to start"
        )
        .then((choice) => {
          if (choice === "How to start") {
            vscode.window.showInformationMessage(
              "In your Dev_Agent folder: activate venv, then run: python server.py"
            );
          }
        });
    }
  }

  // ── Ping (used by chatPanel on webview ready too) ─────────────────────────

  async ping(): Promise<boolean> {
    return this._ping();
  }

  private _ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = new URL(`${this.serverUrl}/health`);
      const req = http.get(
        {
          hostname: url.hostname,
          port:     url.port || 8001,
          path:     url.pathname,
          timeout:  2000,
        },
        (res) => resolve(res.statusCode === 200)
      );
      req.on("error",   () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  // ── Periodically re-check so badge stays accurate ─────────────────────────

  startPolling(intervalMs = 15000) {
    const poll = async () => {
      const alive = await this._ping();
      this._setStatus(alive ? "running" : "stopped");
    };
    const id = setInterval(poll, intervalMs);
    this.context.subscriptions.push({ dispose: () => clearInterval(id) });
  }

  stop() {
    this._setStatus("stopped");
  }

  private _setStatus(s: typeof this._status) {
    this._status = s;
    this._onStatusChange.fire(s);
  }
}