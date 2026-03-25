// src/serverManager.ts
import * as vscode from "vscode";
import * as http from "http";

export class ServerManager {
  private _onStatusChange = new vscode.EventEmitter<string>();
  readonly onStatusChange = this._onStatusChange.event;
  private _status: "stopped" | "starting" | "running" | "error" = "stopped";
  private _pollInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  get status() { return this._status; }

  get serverUrl(): string {
    return vscode.workspace
      .getConfiguration("devAgent")
      .get("serverUrl", "http://localhost:8002");
  }

  async checkAndNotify() {
    const alive = await this._ping();
    if (alive) {
      this._setStatus("running");
    } else {
      this._setStatus("stopped");
      vscode.window.showWarningMessage(
        `Dev Agent: Server not reachable at ${this.serverUrl}. Start it with: python server.py`,
        "How to start"
      ).then((choice) => {
        if (choice === "How to start") {
          vscode.window.showInformationMessage(
            "In your Dev_Agent folder: activate venv, then run: python server.py"
          );
        }
      });
    }
  }

  async ping(): Promise<boolean> { return this._ping(); }

  private _ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = new URL(`${this.serverUrl}/health`);
      console.log("[DevAgent] pinging:", url.hostname, url.port, url.pathname);
      const req = http.get(
        { hostname: url.hostname, port: Number(url.port) || 8002,
          path: url.pathname, timeout: 2000 },
        (res) => {resolve(res.statusCode === 200),console.log("[DevAgent] ping response status:", res.statusCode);}
        
      );
      req.on("error",   (e) => {resolve(false),console.log("[DevAgent] ping error:", e.message);});
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  startPolling(intervalMs = 15000) {
    if (this._pollInterval) { clearInterval(this._pollInterval); }
    this._pollInterval = setInterval(async () => {
      const alive = await this._ping();
      this._setStatus(alive ? "running" : "stopped");
    }, intervalMs);
  }

  stop() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = undefined;
    }
    this._setStatus("stopped");
  }

  private _setStatus(s: typeof this._status) {
    this._status = s;
    this._onStatusChange.fire(s);
  }
}