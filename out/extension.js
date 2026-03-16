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
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const chatPanel_1 = require("./chatPanel");
const serverManager_1 = require("./serverManager");
let serverManager;
function activate(context) {
    console.log("[DevAgent] Extension activating");
    serverManager = new serverManager_1.ServerManager(context);
    // ── Commands ───────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("devAgent.openChat", () => {
        chatPanel_1.ChatPanel.createOrShow(context, serverManager);
    }), vscode.commands.registerCommand("devAgent.newSession", async () => {
        const name = await vscode.window.showInputBox({
            prompt: "Project name (e.g. Orders API)",
            placeHolder: "My API",
        });
        if (name) {
            chatPanel_1.ChatPanel.createOrShow(context, serverManager);
            chatPanel_1.ChatPanel.current?.startNewSession(name);
        }
    }));
    // ── Open chat panel ────────────────────────────────────────────────────────
    chatPanel_1.ChatPanel.createOrShow(context, serverManager);
    // ── Check server is reachable, then poll every 15s ────────────────────────
    serverManager.checkAndNotify();
    serverManager.startPolling(15000);
}
function deactivate() {
    serverManager?.stop();
}
