"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerManager = void 0;
// src/serverManager.ts
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
class ServerManager {
    constructor(context) {
        this.context = context;
        this._onStatusChange = new vscode.EventEmitter();
        this.onStatusChange = this._onStatusChange.event;
        this._status = "stopped";
    }
    get status() {
        return this._status;
    }
    get serverUrl() {
        return vscode.workspace
            .getConfiguration("devAgent")
            .get("serverUrl", "http://localhost:8001");
    }
    // ── Check server and update status badge ──────────────────────────────────
    async checkAndNotify() {
        const alive = await this._ping();
        if (alive) {
            this._setStatus("running");
        }
        else {
            this._setStatus("stopped");
            vscode.window
                .showWarningMessage(`Dev Agent: Server not reachable at ${this.serverUrl}. ` +
                `Start it with: python server.py`, "How to start")
                .then((choice) => {
                if (choice === "How to start") {
                    vscode.window.showInformationMessage("In your Dev_Agent folder: activate venv, then run: python server.py");
                }
            });
        }
    }
    // ── Ping (used by chatPanel on webview ready too) ─────────────────────────
    async ping() {
        return this._ping();
    }
    _ping() {
        return new Promise((resolve) => {
            const url = new URL(`${this.serverUrl}/health`);
            const req = http.get({
                hostname: url.hostname,
                port: url.port || 8001,
                path: url.pathname,
                timeout: 2000,
            }, (res) => resolve(res.statusCode === 200));
            req.on("error", () => resolve(false));
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
    _setStatus(s) {
        this._status = s;
        this._onStatusChange.fire(s);
    }
}
exports.ServerManager = ServerManager;
