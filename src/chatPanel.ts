// src/chatPanel.ts
import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { FileWriter } from "./fileWriter";
import { ServerManager } from "./serverManager";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string[];
  validation?: { valid: boolean; error_count: number; warning_count: number };
}

export class ChatPanel {
  public static current: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _sessionId: string | undefined;
  private _userId: string;
  private _projectName: string | undefined;
  private _messages: Message[] = [];
  private _fileWriter: FileWriter;
  private _fileWatcher: vscode.FileSystemWatcher | undefined;

  private constructor(
    private context: vscode.ExtensionContext,
    private serverManager: ServerManager
  ) {
    // Use VS Code machine ID as user identifier — unique per machine, no login needed
    this._userId = vscode.env.machineId;
    this._fileWriter = new FileWriter();

    this._panel = vscode.window.createWebviewPanel(
      "devAgentChat",
      "Dev Agent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => {
      this._fileWatcher?.dispose();
      ChatPanel.current = undefined;
    });

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "send":        await this._handleSend(msg.text); break;
        case "newSession":  await this.startNewSession(msg.name); break;
        case "publish":     await this._handlePublish(); break;
        case "ready":       await this._onWebviewReady(); break;
      }
    });

    serverManager.onStatusChange((status) => {
      this._panel.webview.postMessage({ type: "serverStatus", status });
    });
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  static createOrShow(context: vscode.ExtensionContext, serverManager: ServerManager) {
    if (ChatPanel.current) {
      ChatPanel.current._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    ChatPanel.current = new ChatPanel(context, serverManager);
  }

  // ── On webview ready — auto-init session from workspace ───────────────────

  private async _onWebviewReady() {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;

    const projectName = path.basename(wsFolder.uri.fsPath);
    const alive = await this.serverManager.ping();
    if (!alive) return;

    await this.startNewSession(projectName, /*autoInit*/ true);
  }

  // ── Session ───────────────────────────────────────────────────────────────

  async startNewSession(projectName: string, autoInit = false) {
    try {
      const resp = await this._post("/session/init", {
        project_name: projectName,
        user_id: this._userId,
      });
      this._sessionId   = resp.session_id;
      this._projectName = projectName;
      this._messages    = [];

      this._post_message({
        type: "sessionStarted",
        projectName,
        sessionId:  resp.session_id,
        isNew:      resp.is_new,
        fileCount:  resp.file_count,
        files:      resp.files,
      });

      const label = autoInit ? "auto-opened" : "started";
      this._addSystemMessage(
        resp.is_new
          ? `📁 New session ${label}: **${projectName}**`
          : `📁 Resumed session for **${projectName}** (${resp.file_count} file(s) on disk)`
      );

      // Start watching raml/ folder for manual edits
      this._startFileWatcher();
    } catch (e: any) {
      if (!autoInit) {
        this._addSystemMessage(`❌ Could not init session: ${e.message}`);
      }
    }
  }

  // ── Watch raml/ folder — sync manual edits back to session ───────────────

  private _startFileWatcher() {
    this._fileWatcher?.dispose();
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder || !this._sessionId) return;

    const ramlDir = path.join(wsFolder, "raml");
    const pattern = new vscode.RelativePattern(ramlDir, "**/*");

    this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const syncFile = async (uri: vscode.Uri) => {
      if (!this._sessionId) return;
      try {
        const content      = fs.readFileSync(uri.fsPath, "utf8");
        const relativePath = path.relative(ramlDir, uri.fsPath).replace(/\\/g, "/");
        await this._put(`/session/${this._sessionId}/files`, {
          files: { [relativePath]: content },
        });
      } catch { /* ignore read errors on delete */ }
    };

    this._fileWatcher.onDidChange(syncFile);
    this._fileWatcher.onDidCreate(syncFile);
  }

  // ── Publish to Anypoint ───────────────────────────────────────────────────

  private async _handlePublish() {
    if (!this._sessionId) {
      vscode.window.showErrorMessage("Dev Agent: No active session.");
      return;
    }

    // Collect credentials via input boxes (pre-fill from env if available)
    const username = await vscode.window.showInputBox({
      prompt: "Anypoint Username", ignoreFocusOut: true,
      value: process.env.ANYPOINT_USERNAME || "",
    });
    if (!username) return;

    const password = await vscode.window.showInputBox({
      prompt: "Anypoint Password", password: true, ignoreFocusOut: true,
    });
    if (!password) return;

    const orgId = await vscode.window.showInputBox({
      prompt: "Anypoint Org ID", ignoreFocusOut: true,
      value: process.env.ANYPOINT_ORG_ID || "",
    });
    if (!orgId) return;

    const ownerId = await vscode.window.showInputBox({
      prompt: "Anypoint Owner ID (leave blank to use Org ID)",
      ignoreFocusOut: true,
      value: process.env.ANYPOINT_OWNER_ID || "",
    });

    this._addSystemMessage("⏳ Publishing to Anypoint Exchange…");

    try {
      const result = await this._post("/publish", {
        session_id: this._sessionId,
        username,
        password,
        org_id:    orgId,
        owner_id:  ownerId || orgId,
      });

      if (result.success) {
        this._addSystemMessage(
          `✅ Published to Anypoint! Action: **${result.action}**, ` +
          `Files: **${result.file_count}**`
        );
      } else {
        this._addSystemMessage(`❌ Publish failed: ${result.error}`);
      }
    } catch (e: any) {
      this._addSystemMessage(`❌ Publish error: ${e.message}`);
    }
  }

  // ── Send a message ────────────────────────────────────────────────────────

  private async _handleSend(text: string) {
    if (!text.trim()) return;

    if (!this._sessionId) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const name     = wsFolder ? path.basename(wsFolder.uri.fsPath) : "New Project";
      await this.startNewSession(name);
    }

    this._messages.push({ role: "user", content: text });
    this._post_message({ type: "userMessage", text });

    const assistantMsg: Message = { role: "assistant", content: "", thinking: [] };
    this._messages.push(assistantMsg);
    this._post_message({ type: "assistantStart" });

    try {
      await this._streamChat(text, assistantMsg);
    } catch (e: any) {
      this._post_message({
        type: "assistantError",
        text: `Server error: ${e.message}. Is the Dev Agent server running?`,
      });
    }
  }

  private async _streamChat(text: string, assistantMsg: Message) {
    const serverUrl = this.serverManager.serverUrl;
    const url       = new URL(`${serverUrl}/chat`);
    const body      = JSON.stringify({
      message:    text,
      session_id: this._sessionId,
      user_id:    this._userId,
    });

    return new Promise<void>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port:     Number(url.port) || 8002,
            timeout:  0,
          path:     url.pathname,
          method:   "POST",
          headers:  {
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6));
                this._handleSseEvent(event, assistantMsg);
              } catch { }
            }
          });
          res.on("end", () => resolve());
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.setTimeout(0);
      req.write(body);
      req.end();
    });
  }

  private async _handleSseEvent(event: any, assistantMsg: Message) {
    switch (event.type) {
      case "thinking":
        assistantMsg.thinking?.push(event.label);
        this._post_message({ type: "thinking", label: event.label });
        break;

      case "tool_done":
        this._post_message({ type: "toolDone", tool: event.tool, summary: event.summary });
        break;

      case "files": {
        // Write to raml/ subfolder in workspace
        const written = await this._fileWriter.writeFiles(
          event.files,
          event.changed_files ?? [],
          event.deleted_files ?? []
        );
        if (written.length > 0) {
          this._fileWriter.showFilesNotification(written);
          this._post_message({
            type:         "filesWritten",
            count:        written.length,
            changedFiles: event.changed_files ?? [],
          });
        }
        break;
      }

      case "validation":
        assistantMsg.validation = event;
        this._post_message({ type: "validation", ...event });
        break;

      case "message":
        assistantMsg.content = event.text;
        this._post_message({ type: "assistantMessage", text: event.text });
        break;

      case "done":
        this._post_message({ type: "done" });
        break;

      case "error":
        this._post_message({ type: "assistantError", text: event.message });
        break;
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private _post(urlPath: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const url     = new URL(`${this.serverManager.serverUrl}${urlPath}`);
      const payload = JSON.stringify(body);
      const lib     = url.protocol === "https:" ? https : http;
      const req     = lib.request(
        {
          hostname: url.hostname, port: Number(url.port) || 8002,
          path: url.pathname, method: "POST",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`Invalid JSON: ${data}`)); }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  private _put(urlPath: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const url     = new URL(`${this.serverManager.serverUrl}${urlPath}`);
      const payload = JSON.stringify(body);
      const lib     = url.protocol === "https:" ? https : http;
      const req     = lib.request(
        {
          hostname: url.hostname, port: Number(url.port) || 8002,
          path: url.pathname, method: "PUT",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`Invalid JSON: ${data}`)); }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  private _post_message(msg: object) {
    this._panel.webview.postMessage(msg);
  }

  private _addSystemMessage(text: string) {
    this._post_message({ type: "systemMessage", text });
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private _getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Agent</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size:   var(--vscode-font-size);
    background:  var(--vscode-sideBar-background);
    color:       var(--vscode-foreground);
    display:     flex;
    flex-direction: column;
    height:      100vh;
    overflow:    hidden;
  }
  #header {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    padding:         10px 14px;
    background:      var(--vscode-titleBar-activeBackground);
    border-bottom:   1px solid var(--vscode-widget-border);
    flex-shrink:     0;
    gap:             8px;
  }
  #header h1 { font-size: 13px; font-weight: 600; flex: 1; }
  #server-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  #server-badge.running  { background: #1a7f37; color: #fff; }
  #server-badge.starting { background: #9a6700; color: #fff; }
  #server-badge.error    { background: #b91c1c; color: #fff; }
  #publish-btn {
    background: #1a7f37; color: #fff; border: none; border-radius: 4px;
    padding: 3px 10px; cursor: pointer; font-size: 11px; flex-shrink: 0;
  }
  #publish-btn:hover { opacity: 0.85; }
  #publish-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  #session-bar {
    display: flex; align-items: center; gap: 8px; padding: 8px 14px;
    border-bottom: 1px solid var(--vscode-widget-border);
    flex-shrink: 0; font-size: 11px; color: var(--vscode-descriptionForeground);
  }
  #session-bar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px;
  }
  #session-bar button:hover { opacity: 0.85; }
  #messages {
    flex: 1; overflow-y: auto; padding: 16px 14px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
  .msg.user   { align-items: flex-end; }
  .msg.system { align-items: center; }
  .bubble {
    padding: 10px 14px; border-radius: 12px;
    line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-width: 90%;
  }
  .msg.user .bubble {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-radius: 12px 12px 2px 12px;
  }
  .msg.assistant .bubble {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 2px 12px 12px 12px; width: 100%;
  }
  .msg.system .bubble {
    background: transparent; color: var(--vscode-descriptionForeground);
    font-size: 11px; text-align: center;
    border: 1px solid var(--vscode-widget-border); border-radius: 8px;
    padding: 6px 12px; max-width: 100%;
  }
  .thinking-steps { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .thinking-step {
    display: flex; align-items: center; gap: 7px;
    font-size: 11px; color: var(--vscode-descriptionForeground);
  }
  .thinking-step .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--vscode-progressBar-background); flex-shrink: 0;
  }
  .thinking-step.done .dot { background: #1a7f37; }
  .validation-badge {
    display: inline-block; font-size: 11px; padding: 3px 10px;
    border-radius: 8px; margin-top: 8px;
  }
  .validation-badge.ok    { background: #1a7f3720; color: #1a7f37; }
  .validation-badge.error { background: #b91c1c20; color: #b91c1c; }
  .files-badge { font-size: 11px; color: var(--vscode-textLink-foreground); margin-top: 6px; }
  .spinner {
    display: inline-block; width: 12px; height: 12px;
    border: 2px solid var(--vscode-progressBar-background);
    border-top-color: transparent; border-radius: 50%;
    animation: spin 0.7s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
    background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px;
  }
  .bubble pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-widget-border); border-radius: 6px;
    padding: 10px 12px; overflow-x: auto; margin: 8px 0;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5;
  }
  #input-area {
    padding: 12px 14px; border-top: 1px solid var(--vscode-widget-border);
    background: var(--vscode-sideBar-background); flex-shrink: 0;
  }
  #input-wrapper {
    display: flex; align-items: flex-end; gap: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 10px; padding: 8px 12px;
  }
  #input-wrapper:focus-within { border-color: var(--vscode-focusBorder); }
  #input {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    resize: none; max-height: 140px; min-height: 22px; line-height: 1.5;
  }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #send-btn {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; width: 30px; height: 30px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  #send-btn:hover { opacity: 0.85; }
  #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  #hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 5px; text-align: center; }
</style>
</head>
<body>

<div id="header">
  <h1>⚡ Dev Agent</h1>
  <span id="server-badge" class="stopped">● Stopped</span>
  <button id="publish-btn" onclick="publishToAnypoint()" disabled title="Publish to Anypoint Exchange">↑ Publish</button>
</div>

<div id="session-bar">
  <span id="session-label">Initialising…</span>
  <button onclick="promptNewSession()">＋ New Session</button>
</div>

<div id="messages">
  <div class="msg system">
    <div class="bubble">Connecting to Dev Agent server…</div>
  </div>
</div>

<div id="input-area">
  <div id="input-wrapper">
    <textarea id="input" rows="1"
      placeholder="Describe the API you want to create…"></textarea>
    <button id="send-btn" title="Send (Enter)" onclick="sendMessage()">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 1.5l13 6.5-13 6.5V9.5l9-1.5-9-1.5V1.5z"/>
      </svg>
    </button>
  </div>
  <div id="hint">Enter to send · Shift+Enter for new line</div>
</div>

<script>
const vscode      = acquireVsCodeApi();
let isStreaming   = false;
let hasSession    = false;
let currentAssistantEl = null;

// ── Auto-resize textarea ──────────────────────────────────────────────────
const input = document.getElementById('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Actions ───────────────────────────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;
  input.value = ''; input.style.height = 'auto';
  vscode.postMessage({ type: 'send', text });
}
function promptNewSession() {
  const name = prompt('Project name:');
  if (name?.trim()) vscode.postMessage({ type: 'newSession', name: name.trim() });
}
function publishToAnypoint() {
  vscode.postMessage({ type: 'publish' });
}

// ── Rendering ─────────────────────────────────────────────────────────────
const messages = document.getElementById('messages');
function scrollToBottom() { messages.scrollTop = messages.scrollHeight; }

function addUserBubble(text) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.innerHTML = \`<div class="bubble">\${escHtml(text)}</div>\`;
  messages.appendChild(d); scrollToBottom();
}
function addSystemBubble(text) {
  const d = document.createElement('div');
  d.className = 'msg system';
  d.innerHTML = \`<div class="bubble">\${renderMd(text)}</div>\`;
  messages.appendChild(d); scrollToBottom();
}
function startAssistantBubble() {
  isStreaming = true;
  document.getElementById('send-btn').disabled = true;
  const div    = document.createElement('div'); div.className = 'msg assistant';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const tEl    = document.createElement('div'); tEl.className = 'thinking-steps';
  const cEl    = document.createElement('div'); cEl.className = 'content';
  bubble.appendChild(tEl); bubble.appendChild(cEl); div.appendChild(bubble);
  messages.appendChild(div); scrollToBottom();
  currentAssistantEl = { div, bubble, thinkingEl: tEl, contentEl: cEl };
}
function addThinkingStep(label) {
  if (!currentAssistantEl) return;
  const s = document.createElement('div'); s.className = 'thinking-step';
  s.innerHTML = \`<span class="dot"></span><span class="spinner"></span><span>\${escHtml(label)}</span>\`;
  currentAssistantEl.thinkingEl.appendChild(s); scrollToBottom();
}
function markLastThinkingDone(summary) {
  if (!currentAssistantEl) return;
  const steps = currentAssistantEl.thinkingEl.querySelectorAll('.thinking-step');
  const last  = steps[steps.length - 1]; if (!last) return;
  last.classList.add('done');
  last.querySelector('.spinner')?.remove();
  const lbl = last.querySelector('span:last-child');
  if (lbl && summary) lbl.textContent = summary;
}
function setAssistantContent(text) {
  if (!currentAssistantEl) return;
  currentAssistantEl.contentEl.innerHTML = renderMd(text); scrollToBottom();
}
function addValidationBadge(valid, ec, wc) {
  if (!currentAssistantEl) return;
  const b = document.createElement('div');
  b.className = \`validation-badge \${valid ? 'ok' : 'error'}\`;
  b.textContent = valid ? \`✓ Valid — \${wc} warning(s)\` : \`✗ \${ec} error(s), \${wc} warning(s)\`;
  currentAssistantEl.bubble.appendChild(b); scrollToBottom();
}
function addFilesBadge(count, changedFiles) {
  if (!currentAssistantEl) return;
  const b = document.createElement('div'); b.className = 'files-badge';
  const names = (changedFiles||[]).slice(0,3).join(', ');
  const extra = (changedFiles||[]).length > 3 ? \` +\${changedFiles.length-3} more\` : '';
  b.textContent = \`📄 \${count} file(s) written to raml/: \${names}\${extra}\`;
  currentAssistantEl.bubble.appendChild(b); scrollToBottom();
}
function finishBubble() {
  isStreaming = false;
  document.getElementById('send-btn').disabled = false;
  currentAssistantEl = null; input.focus();
}

// ── Markdown ─────────────────────────────────────────────────────────────
function renderMd(text) {
  let h = escHtml(text);
  h = h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_,l,c) => \`<pre><code>\${c}</code></pre>\`);
  h = h.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  h = h.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  h = h.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');
  h = h.replace(/\\n/g, '<br>');
  return h;
}
function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Messages from extension ───────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'serverStatus': {
      const b = document.getElementById('server-badge');
      b.className = msg.status;
      b.textContent = msg.status === 'running'  ? '● Running'  :
                      msg.status === 'starting' ? '● Starting…':
                      msg.status === 'error'    ? '● Error'    : '● Stopped';
      break;
    }
    case 'sessionStarted':
      hasSession = true;
      document.getElementById('session-label').textContent = \`📁 \${msg.projectName}\`;
      document.getElementById('publish-btn').disabled = false;
      addSystemBubble(msg.isNew
        ? \`New session: **\${msg.projectName}**\`
        : \`Resumed **\${msg.projectName}** — \${msg.fileCount} file(s) on disk\`);
      break;
    case 'userMessage':    addUserBubble(msg.text); break;
    case 'assistantStart': startAssistantBubble(); break;
    case 'thinking':       addThinkingStep(msg.label); break;
    case 'toolDone':       markLastThinkingDone(msg.summary); break;
    case 'filesWritten':   addFilesBadge(msg.count, msg.changedFiles); break;
    case 'validation':     addValidationBadge(msg.valid, msg.error_count, msg.warning_count); break;
    case 'assistantMessage': setAssistantContent(msg.text); break;
    case 'systemMessage':  addSystemBubble(msg.text); break;
    case 'assistantError':
      if (currentAssistantEl) {
        currentAssistantEl.contentEl.innerHTML =
          \`<span style="color:var(--vscode-errorForeground)">\${escHtml(msg.text)}</span>\`;
      } else { addSystemBubble('❌ ' + msg.text); }
      finishBubble(); break;
    case 'done': finishBubble(); break;
  }
});

// Tell extension webview is ready — triggers auto session init
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}