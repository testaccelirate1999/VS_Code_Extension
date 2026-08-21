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
  mode?: "plan" | "act";
  thinking?: string[];
  validation?: { valid: boolean; error_count: number; warning_count: number };
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = "devAgent.chatView";
  public static current: ChatPanel | undefined;

  // The active WebviewView assigned by VS Code when the sidebar panel is opened
  private _view: vscode.WebviewView | undefined;

  private _sessionId: string | undefined;
  private _userId: string;
  private _projectName: string | undefined;
  private _messages: Message[] = [];
  private _fileWriter: FileWriter;
  private _fileWatcher: vscode.FileSystemWatcher | undefined;
  private _mode: "plan" | "act" = "plan";
  // Count of plan-mode messages already included in a previously sent
  // plan_summary — _buildPlanSummary() only serializes messages past this
  // point, so a planning conversation is delivered to the agent once, not
  // re-sent in full on every subsequent Act-mode message.
  private _planSummaryDeliveredCount = 0;
  // Manual mode holds writes for approval before they touch the real
  // workspace; Auto writes immediately, same as today's behavior.
  private _approvalMode: "auto" | "manual" = "auto";
  // Resolvers for approval cards awaiting a click in the webview, keyed by
  // requestId — resolved when the "approvalResponse" message arrives.
  private _pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private _approvalRequestSeq = 0;
  private _nonce: string = "";

  constructor(
    private context: vscode.ExtensionContext,
    private serverManager: ServerManager
  ) {
    this._userId = vscode.env.machineId;
    this._fileWriter = new FileWriter();
    ChatPanel.current = this;

    // Keep UI in sync whenever the server status changes
    serverManager.onStatusChange((status) => {
      this._view?.webview.postMessage({ type: "serverStatus", status });
    });
  }

  // ── WebviewViewProvider entry point (called by VS Code) ───────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    this._nonce = getNonce();
    webviewView.webview.html = this._getHtml();

    // Send current server status once the view is ready
    setTimeout(() => {
      webviewView.webview.postMessage({
        type: "serverStatus",
        status: this.serverManager.status,
      });
    }, 300);

    // Fallback in case the webview 'ready' message is delayed
    let readyFired = false;
    const fallback = setTimeout(() => {
      if (!readyFired) {
        readyFired = true;
        console.log("[DevAgent] fallback timeout firing");
        this._onWebviewReady();
      }
    }, 3000);

    webviewView.onDidDispose(() => {
      clearTimeout(fallback);
      this._fileWatcher?.dispose();
      // Don't null out ChatPanel.current — the provider instance stays alive
      // so that VS Code can call resolveWebviewView again when re-opened
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "send":       await this._handleSend(msg.text, msg.attachments); break;
        case "newSession": await this.startNewSession(msg.name); break;
        case "publish":    await this._handlePublish(); break;
        case "setMode":         this._setMode(msg.mode); break;
        case "setApprovalMode": this._setApprovalMode(msg.mode); break;
        case "approvalResponse": this._resolveApproval(msg.requestId, msg.approved); break;
        case "ready":
          if (!readyFired) {
            readyFired = true;
            clearTimeout(fallback);
            console.log("[DevAgent] ready message received from webview");
            await this._onWebviewReady();
          }
          break;
      }
    });
  }

  // ── Factory — now just a registration helper ───────────────────────────────

  static createOrShow(context: vscode.ExtensionContext, serverManager: ServerManager) {
    // The provider is registered in extension.ts; just focus the view
    vscode.commands.executeCommand("devAgent.chatView.focus");
  }

  // ── Webview ready ─────────────────────────────────────────────────────────

  private async _onWebviewReady() {
    console.log("[DevAgent] _onWebviewReady called");
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    console.log("[DevAgent] wsFolder:", wsFolder?.uri.fsPath);
    if (!wsFolder) {
      this._addSystemMessage("⚠️ No workspace folder open.");
      return;
    }

    const projectName = path.basename(wsFolder.uri.fsPath);

    const alive = await this.serverManager.ping();
    console.log("[DevAgent] ping alive:", alive);
    console.log("[DevAgent] serverUrl:", this.serverManager.serverUrl);

    this._view?.webview.postMessage({
      type: "serverStatus",
      status: this.serverManager.status,
    });

    if (!alive) {
      this._addSystemMessage("⚠️ Server not reachable. Check server is running.");
      return;
    }

    await this.startNewSession(projectName, true);
  }

  // ── Mode ──────────────────────────────────────────────────────────────────

  private _setMode(mode: "plan" | "act") {
    this._mode = mode;
    this._view?.webview.postMessage({ type: "modeChanged", mode });
    // No chat notification — the UI theme change makes the switch self-evident
  }

  private _setApprovalMode(mode: "auto" | "manual") {
    this._approvalMode = mode;
    this._view?.webview.postMessage({ type: "approvalModeChanged", mode });
  }

  // ── Manual-approval writes ───────────────────────────────────────────────

  /** Show an approval card in the chat and wait for the user's click. */
  private _requestApproval(
    files: string[], deletedFiles: string[]
  ): { requestId: string; result: Promise<boolean> } {
    const requestId = "appr-" + (++this._approvalRequestSeq);
    this._post_message({
      type: "approvalRequest",
      requestId,
      files,
      deletedFiles,
    });
    const result = new Promise<boolean>((resolve) => {
      this._pendingApprovals.set(requestId, resolve);
    });
    return { requestId, result };
  }

  private _resolveApproval(requestId: string, approved: boolean) {
    const resolve = this._pendingApprovals.get(requestId);
    if (!resolve) { return; }
    this._pendingApprovals.delete(requestId);
    resolve(approved);
  }

  private _buildPlanSummary(): string {
    const planMsgs = this._messages.filter(m => m.mode === "plan");
    // Only the plan messages not yet delivered in a prior plan_summary — the
    // rest are already in the server-side conversation history from when
    // they were delivered, so re-sending them again would just duplicate
    // tokens on every later Act-mode turn.
    const newMsgs = planMsgs.slice(this._planSummaryDeliveredCount);
    if (newMsgs.length === 0) { return ""; }
    this._planSummaryDeliveredCount = planMsgs.length;
    const lines = newMsgs.map(m =>
      (m.role === "user" ? "User" : "Agent") + ": " + m.content
    );
    return (
      "=== PLANNING CONVERSATION ===\n" +
      lines.join("\n") +
      "\n=== END PLAN ===\n" +
      "Based on the above planning conversation, now execute the user's instruction."
    );
  }

  // ── Session ───────────────────────────────────────────────────────────────

  async startNewSession(projectName: string, autoInit = false) {
    console.log("[DevAgent] startNewSession:", projectName);
    try {
      console.log("[DevAgent] calling /session/init");
      const resp = await this._post("/session/init", {
        project_name: projectName,
        user_id: this._userId,
      });
      console.log("[DevAgent] session/init response:", JSON.stringify(resp));
      this._sessionId   = resp.session_id;
      this._projectName = projectName;
      this._messages    = [];
      this._mode        = "plan";
      this._planSummaryDeliveredCount = 0;
      this._approvalMode = "auto";
      this._pendingApprovals.clear();

      this._post_message({
        type: "sessionStarted",
        projectName,
        sessionId:  resp.session_id,
        isNew:      resp.is_new,
        fileCount:  resp.file_count,
        files:      resp.files,
      });

      this._view?.webview.postMessage({ type: "modeChanged", mode: "plan" });

      if (!autoInit) {
      this._addSystemMessage(
        resp.is_new
          ? "📁 New session started: **" + projectName + "**"
          : "📁 Resumed session for **" + projectName + "** (" + (resp.file_count ?? 0) + " file(s) on disk)"
      );
    }

      // Replay past turns into the panel on every resume — including the
      // silent autoInit path, which is what runs on a VS Code window
      // reload. Without this the agent still remembers the conversation
      // (session.history persists server-side) but the chat panel itself
      // would look empty until the next message.
      if (!resp.is_new && Array.isArray(resp.history) && resp.history.length > 0) {
        this._replayHistory(resp.history);
      }

      this._addSystemMessage("🚀 All set. Go ahead.");

      this._startFileWatcher();
      await this._syncWorkspaceToSession(resp.session_id, resp.files ?? []);
    } catch (e: any) {
      console.log("[DevAgent] startNewSession error:", e.message);
      if (!autoInit) {
        this._addSystemMessage("❌ Could not init session: " + e.message);
      }
    }
  }

  /** Rebuilds chat bubbles from server-stored history — reuses the exact
   *  same webview message types the live streaming path uses (including
   *  the approval-card pair, when a turn's write was approved/rejected),
   *  so no separate rendering logic is needed on the webview side. */
  private _replayHistory(history: {
    role: string; content: string;
    approval?: { files: string[]; deleted_files: string[]; approved: boolean };
  }[]) {
    for (const h of history) {
      if (h.role === "user") {
        const msg: Message = { role: "user", content: h.content, mode: "act" };
        this._messages.push(msg);
        this._post_message({ type: "userMessage", text: h.content, mode: "act", attachments: [] });
      } else if (h.role === "assistant") {
        const msg: Message = { role: "assistant", content: h.content, mode: "act" };
        this._messages.push(msg);
        this._post_message({ type: "assistantStart", mode: "act" });
        this._post_message({ type: "assistantMessage", text: h.content });
        if (h.approval) {
          const requestId = "appr-replay-" + (++this._approvalRequestSeq);
          this._post_message({
            type: "approvalRequest",
            requestId,
            files: h.approval.files,
            deletedFiles: h.approval.deleted_files,
          });
          this._post_message({ type: "approvalResolved", requestId, approved: h.approval.approved });
        }
        this._post_message({ type: "done" });
      }
    }
  }

  // ── File watcher ──────────────────────────────────────────────────────────

  private _startFileWatcher() {
    this._fileWatcher?.dispose();
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder || !this._sessionId) { return; }

    const pattern = new vscode.RelativePattern(wsFolder,
        "{src/main/**/*,src/test/**/*,pom.xml,mule-artifact.json}"
    );
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const syncFile = async (uri: vscode.Uri) => {
      if (!this._sessionId) { return; }
      try {
        const content      = fs.readFileSync(uri.fsPath, "utf8");
        const relativePath = path.relative(wsFolder, uri.fsPath).replace(/\\/g, "/");
        await this._put("/session/" + this._sessionId + "/files", {
          files: { [relativePath]: content },
        });
      } catch { /* ignore */ }
    };

    const deleteFile = async (uri: vscode.Uri) => {
      if (!this._sessionId) { return; }
      try {
        const relativePath = path.relative(wsFolder, uri.fsPath).replace(/\\/g, "/");
        await this._put("/session/" + this._sessionId + "/files", {
          files:         {},
          deleted_files: [relativePath],
        });
        console.log(`[DevAgent] File deleted from session: ${relativePath}`);
      } catch { /* ignore */ }
    };

    this._fileWatcher.onDidChange(syncFile);
    this._fileWatcher.onDidCreate(syncFile);
    this._fileWatcher.onDidDelete(deleteFile);
  }
// ── File Sync ──────────────────────────────────────────────────────────
  private async _get(path: string): Promise<any> {
    const url = this.serverManager.serverUrl + path;
    const resp = await fetch(url);
    return resp.json();
}
  private async _syncWorkspaceToSession(
      sessionId: string,
      sessionFilePaths: string[] = []    // ← files currently in server session
  ): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return; }

    // Scan workspace files
    const filesToSync: Record<string, string> = {};
    const scanDirs = [
        "src/main/mule",
        "src/main/resources",
        "src/test/munit",
        "src/test/resources",
    ];
    for (const dir of scanDirs) {
        const fullDir = path.join(wsRoot, dir);
        if (!fs.existsSync(fullDir)) { continue; }
        this._scanDir(fullDir, wsRoot, filesToSync);
    }
    for (const f of ["pom.xml", "mule-artifact.json", "log4j2.xml"]) {
        const fullPath = path.join(wsRoot, f);
        if (fs.existsSync(fullPath)) {
            filesToSync[f] = fs.readFileSync(fullPath, "utf8");
        }
    }

    const workspacePaths = Object.keys(filesToSync);

    // Files in session but NOT in workspace → deleted
    const deletedFiles = sessionFilePaths.filter(
        p => !workspacePaths.includes(p)
    );

    if (workspacePaths.length === 0 && deletedFiles.length === 0) { return; }

    console.log(`[DevAgent] Syncing workspace: `
        + `${workspacePaths.length} files, ${deletedFiles.length} deleted`);

    try {
        await this._put(`/session/${sessionId}/files`, {
            files:         filesToSync,
            deleted_files: deletedFiles,    // ← remove stale files from session
        });
        this._addSystemMessage(
            `📂 Found ${workspacePaths.length} existing file(s) in workspace — synced to session.`
            + (deletedFiles.length > 0
                ? ` Removed ${deletedFiles.length} stale file(s).`
                : "")
        );
    } catch (e: any) {
        console.error("[DevAgent] Workspace sync failed:", e.message);
    }
  }

  private _scanDir(
      dirPath: string,
      wsRoot: string,
      result: Record<string, string>
  ): void {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
              this._scanDir(full, wsRoot, result);
          } else if (entry.isFile()) {
              const relative = path.relative(wsRoot, full).replace(/\\/g, "/");
              try {
                  result[relative] = fs.readFileSync(full, "utf8");
              } catch { /* skip unreadable files */ }
          }
      }
  }
  // ── Publish ───────────────────────────────────────────────────────────────

  private async _handlePublish() {
    if (!this._sessionId) {
      vscode.window.showErrorMessage("Flow Agent: No active session.");
      return;
    }

    let init: any;
    try {
      init = await this._post("/anypoint/publish-init", { session_id: this._sessionId });
    } catch (e: any) {
      this._addSystemMessage("❌ Could not start Anypoint login: " + e.message);
      return;
    }
    if (init.error) {
      this._addSystemMessage("❌ Could not start Anypoint login: " + init.error);
      return;
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(init.authorize_url));
    if (!opened) {
      this._addSystemMessage("❌ Could not open the browser for Anypoint login.");
      return;
    }
    this._addSystemMessage("🔐 Log in to Anypoint in your browser, then come back here…");

    await this._pollAnypointPublish(init.state);
  }

  /** Polls /anypoint/publish-status until it lands on done/error, handling
   * the org-picker step in between. Mirrors the shape of the old /publish
   * result message so the final chat output looks the same as before. */
  private async _pollAnypointPublish(state: string) {
    const POLL_MS = 5000;
    const MAX_ATTEMPTS = 12; // 1 minute total, checked every 5s
    let askedForOrg = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      let status: any;
      try {
        status = await this._get(`/anypoint/publish-status/${state}`);
      } catch {
        continue; // transient network hiccup — just try again next tick
      }

      if (status.status === "choose_org" && !askedForOrg) {
        askedForOrg = true; // only prompt once even while polling continues
        // Explicitly typed as QuickPickItem[] — status.orgs comes through as
        // `any` (from the untyped _get() JSON response), and .map() on `any`
        // stays `any`, which makes showQuickPick's overload resolution pick
        // the plain string[] overload instead of the QuickPickItem[] one.
        const items: vscode.QuickPickItem[] = (status.orgs || []).map(
          (o: any) => ({ label: o.name, description: o.id })
        );
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Which Anypoint organization should this publish to?",
          ignoreFocusOut: true,
        });
        if (!picked) {
          this._addSystemMessage("❌ Publish cancelled — no organization selected.");
          return;
        }
        await this._post("/anypoint/publish-select-org", { state, org_id: picked.description });
        continue;
      }

      if (status.status === "done") {
        const result = status.result || {};
        this._addSystemMessage(
          "✅ Published to Anypoint! Action: **" + result.action + "**, Files: **" + result.file_count + "**"
        );
        return;
      }

      if (status.status === "error") {
        this._addSystemMessage("❌ Publish failed: " + status.message);
        return;
      }

      if (status.status === "not_found") {
        this._addSystemMessage("❌ Publish login expired — please try again.");
        return;
      }
      // pending_login / pushing / choose_org (already asked) — keep polling
    }

    this._addSystemMessage("❌ Timed out waiting for Anypoint login — please try again.");
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async _handleSend(text: string,attachments?: []) {
    if (!text.trim()) { return; }

// ── Plan mode guard — block generation commands ───────────────────────

    if (this._mode === "plan") {
      const lower = text.trim().toLowerCase();

      const isQuestion =
        lower.endsWith("?") ||
        /^(what|how|which|when|where|why|can|could|do|does|is|are|will|should|would)\b/.test(lower);

      const isPlanningPhrase =
        /(what|which).*(required|needed|missing|next|more|else|should|include)/i.test(text) ||
        /(more detail|clarif|tell me|explain|describe|advise|suggest|recommend)/i.test(text);

      const hasDirectCommand =
        /^(generate|create|build|make|write|produce|implement|develop|publish)\b/i.test(lower);

      // Only block if it's a direct imperative command — not a question or planning phrase
      if (hasDirectCommand && !isQuestion && !isPlanningPhrase) {
        this._post_message({
          type: "systemMessage",
          text: "⚠️ You're in **Plan mode** — switch to **Act mode** to generate files.",
        });
        return;
      }
    }

    if (!this._sessionId) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const name     = wsFolder ? path.basename(wsFolder.uri.fsPath) : "New Project";
      await this.startNewSession(name);
    }

    const userMsg: Message = { role: "user", content: text, mode: this._mode };
    this._messages.push(userMsg);
    this._post_message({ type: "userMessage", text, mode: this._mode, attachments: attachments ?? [], });

    const assistantMsg: Message = { role: "assistant", content: "", mode: this._mode, thinking: [] };
    this._messages.push(assistantMsg);
    this._post_message({ type: "assistantStart", mode: this._mode });

    try {
      const planSummary = this._mode === "act" ? this._buildPlanSummary() : "";
      await this._streamChat(text, planSummary, assistantMsg, attachments);
    } catch (e: any) {
      this._post_message({
        type: "assistantError",
        text: "Server error: " + e.message + ". Is the Flow Agent server running?",
      });
    }
  }

  private async _streamChat(text: string, planSummary: string, assistantMsg: Message, attachments?: any[] ) {
    const serverUrl = this.serverManager.serverUrl;
    const url       = new URL(serverUrl + "/chat");
    const body      = JSON.stringify({
      message:      text,
      session_id:   this._sessionId,
      user_id:      this._userId,
      mode:         this._mode,
      plan_summary: planSummary,
      attachments:   attachments ?? [],
    });

    return new Promise<void>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port:     Number(url.port) || (url.protocol === "https:" ? 443 : 8002),
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
              if (!line.startsWith("data: ")) { continue; }
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
        const writeId = event.write_id as string | undefined;

        if (this._approvalMode === "manual" && writeId) {
          const targetPaths = (event.changed_files && event.changed_files.length > 0)
            ? event.changed_files
            : Object.keys(event.files ?? {});
          const { requestId, result } = this._requestApproval(targetPaths, event.deleted_files ?? []);
          const approved = await result;
          if (!approved) {
            await this._post("/session/revert-write", { write_id: writeId });
            this._post_message({ type: "approvalResolved", requestId, approved: false });
            break;
          }
          this._post_message({ type: "approvalResolved", requestId, approved: true });
        } else if (writeId) {
          // Auto mode: nothing to hold, just free the snapshot the server staged.
          void this._post("/session/confirm-write", { write_id: writeId });
        }

        const written = await this._fileWriter.writeFiles(
          event.files,
          event.changed_files ?? [],
          event.deleted_files ?? [],
          event.binary_files ?? {}
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
      case "token_update":
          this._post_message({
              type:       "tokenUpdate",
              tokens:     event.tokens,
              max_tokens: event.max_tokens,
              pct:        event.pct,
              level:      event.level,
          });
          break;
      case "token_limit":
          this._post_message({
              type:    "systemMessage",
              text:    `⚠️ ${event.message}`,
          });
          this._post_message({
              type:       "tokenUpdate",
              tokens:     event.tokens,
              max_tokens: event.max_tokens,
              pct:        100,
              level:      "danger",
          });
          this._post_message({
              type:    "tokenLimit",
              summary: event.summary,
          });
          break;
      case "context_reset": {
        this._addSystemMessage(
          "⚠️ Context limit reached — summarized and continuing automatically…"
        );
        // Build a new assistantMsg for the retry
        const retryAssistantMsg: Message = {
          role: "assistant", content: "", mode: this._mode, thinking: []
        };
        this._messages.push(retryAssistantMsg);
        this._post_message({ type: "assistantStart", mode: this._mode });

        // Wait 1 second then retry with summary prepended
        setTimeout(async () => {
          const retryText =
            `[CONTEXT SUMMARY]\n${event.summary}\n\n` +
            `[USER REQUEST] ${event.message}`;
          try {
            await this._streamChat(retryText, "", retryAssistantMsg);
          } catch (e: any) {
            this._post_message({ type: "assistantError", text: e.message });
          }
        }, 1000);
        break;
      }
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private _post(urlPath: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const url     = new URL(this.serverManager.serverUrl + urlPath);
      const payload = JSON.stringify(body);
      const lib     = url.protocol === "https:" ? https : http;
      const req     = lib.request(
        {
          hostname: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 8002),
          path: url.pathname, method: "POST",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error("Invalid JSON: " + data)); }
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
      const url     = new URL(this.serverManager.serverUrl + urlPath);
      const payload = JSON.stringify(body);
      const lib     = url.protocol === "https:" ? https : http;
      const req     = lib.request(
        {
          hostname: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 8002),
          path: url.pathname, method: "PUT",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error("Invalid JSON: " + data)); }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  private _post_message(msg: object) {
    this._view?.webview.postMessage(msg);
  }

  private _addSystemMessage(text: string) {
    this._post_message({ type: "systemMessage", text });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${this._nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src http://localhost:* https://devagent-production-64bc.up.railway.app;">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow Agent</title>
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
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    background: var(--vscode-titleBar-activeBackground);
    border-bottom: 1px solid var(--vscode-widget-border);
    flex-shrink: 0; gap: 8px;
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
  #mode-bar {
    display: flex; align-items: center; gap: 6px; padding: 6px 14px;
    border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0;
  }
  #mode-bar span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .mode-btn {
    font-size: 11px; padding: 3px 14px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--vscode-widget-border);
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
  }
  /* ── Plan mode (green) ── */
  body.mode-plan .mode-btn.active { background: #15803d; color: #fff; border-color: #15803d; }
  body.mode-plan #mode-hint       { color: #4ade80; background: #052e1608; border-bottom-color: #15803d40; }
  body.mode-plan #send-btn        { background: #15803d; }
  body.mode-plan #input-wrapper:focus-within { border-color: #4ade80; }
  body.mode-plan #input-wrapper   { border-color: #15803d50; }
  body.mode-plan .msg.user .bubble { background: #15803d; color: #fff; }

  /* ── Act mode (blue) ── */
  body.mode-act .mode-btn.active  { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  body.mode-act #mode-hint        { color: #60a5fa; background: #0c1d4208; border-bottom-color: #1d4ed840; }
  body.mode-act #send-btn         { background: #1d4ed8; }
  body.mode-act #input-wrapper:focus-within { border-color: #60a5fa; }
  body.mode-act #input-wrapper    { border-color: #1d4ed850; }
  body.mode-act .msg.user .bubble  { background: #1d4ed8; color: #fff; }

  /* active button always gets the mode colour — inactive stays neutral */
  .mode-btn.active.plan { background: #15803d; color: #fff; border-color: #15803d; }
  .mode-btn.active.act  { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  #mode-hint {
    font-size: 10px; padding: 3px 14px; flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-widget-border);
    color: var(--vscode-descriptionForeground);
    transition: color 0.25s, background 0.25s, border-bottom-color 0.25s;
  }
  #approval-bar {
    display: flex; align-items: center; gap: 6px; padding: 6px 14px;
    border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0;
  }
  #approval-bar span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .approval-btn {
    font-size: 11px; padding: 3px 14px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--vscode-widget-border);
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
  }
  .approval-btn.active { background: #9a6700; color: #fff; border-color: #9a6700; }
  .approval-card {
    margin-top: 8px; border: 1px solid var(--vscode-widget-border);
    border-radius: 8px; padding: 8px 10px; background: #9a670012;
  }
  .approval-card-title { font-size: 11px; font-weight: 600; margin-bottom: 4px; }
  .approval-card-files {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 8px;
  }
  .approval-card-actions { display: flex; gap: 8px; }
  .approval-approve, .approval-reject {
    font-size: 11px; padding: 3px 12px; border-radius: 6px; cursor: pointer; border: none;
  }
  .approval-approve { background: #1a7f37; color: #fff; }
  .approval-reject  { background: #b91c1c; color: #fff; }
  .approval-card.resolved .approval-card-actions { display: none; }
  .approval-card.approved { border-color: #1a7f37; }
  .approval-card.rejected { border-color: #b91c1c; }
  .approval-card-status { font-size: 11px; margin-top: 4px; }
  .approval-card.approved .approval-card-status { color: #1a7f37; }
  .approval-card.rejected .approval-card-status { color: #b91c1c; }
  #send-btn { transition: background 0.25s; }
  #input-wrapper { transition: border-color 0.25s; }
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
  #brand-logo { width: 36px; height: 36px; vertical-align: middle; margin-right: 8px; flex-shrink: 0; }
  #header h1  { display: flex; align-items: center; font-size: 13px; font-weight: 600; flex: 1; }
  #attach-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-descriptionForeground); padding: 0 4px 2px;
    font-size: 18px; line-height: 1; flex-shrink: 0; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
  }
  #attach-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  #attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  #attachment-chips {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding: 0 0 5px 0;
  }
  #attachment-chips:empty { display: none; }
  .attach-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 10px; padding: 2px 6px 2px 8px; border-radius: 10px;
    max-width: 160px;
  }
  .attach-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .attach-chip button {
    background: none; border: none; cursor: pointer; padding: 0 1px;
    color: var(--vscode-badge-foreground); font-size: 11px; line-height: 1; flex-shrink: 0;
  }
  .attach-chip button:hover { opacity: 0.7; }
  #token-bar-wrap {
    padding: 4px 12px 6px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  #token-bar-header {
    display: flex; justify-content: space-between;
    font-size: 10px; color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
  }
  #token-track {
    height: 4px; border-radius: 2px;
    background: var(--vscode-widget-border); overflow: hidden;
  }
  #token-fill {
    height: 100%; width: 0%; border-radius: 2px;
    background: var(--vscode-charts-green);
    transition: width 0.3s ease, background 0.3s ease;
  }
</style>
</head>
<body class="mode-plan">

<div id="header">
  <h1>
    <!-- Accelirate-A chevron left + MuleSoft-M arc right, merged into one mark -->
    <img id="brand-logo" src="data:image/png;base64,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" alt="Flow Agent logo"/>
    Flow Agent
  </h1>
  <span id="server-badge" class="stopped">● Stopped</span>
  <button id="publish-btn" disabled title="Publish to Anypoint Exchange">↑ Publish</button>
</div>

<div id="session-bar">
  <span id="session-label">Initialising…</span>
  <button id="new-session-btn">＋ New Session</button>
</div>

<div id="mode-bar">
  <span>Mode:</span>
  <button class="mode-btn active plan" id="btn-plan">📋 Plan</button>
  <button class="mode-btn act"         id="btn-act">🎯 Act</button>
</div>
<div id="mode-hint" class="plan">📋 Plan mode — describe what to build. No files will be written yet</div>

<div id="approval-bar">
  <span>Writes:</span>
  <button class="approval-btn active" id="btn-approval-auto">⚡ Auto</button>
  <button class="approval-btn"        id="btn-approval-manual">🛂 Manual</button>
</div>

<div id="token-bar-wrap">
  <div id="token-bar-header">
    <span>ADK Context</span>
    <span id="token-label">0 / 35,000</span>
  </div>
  <div id="token-track">
    <div id="token-fill"></div>
  </div>
</div>

<div id="messages">
  <div class="msg system">
    <div class="bubble">Connecting to Flow Agent server…</div>
  </div>
</div>

<div id="input-area">
  <div id="attachment-chips"></div>
  <div id="input-wrapper">
    <button id="attach-btn" title="Attach image or document (max 5)">+</button>
    <input type="file" id="file-input"
           accept="image/png,image/jpeg,image/jpg,image/gif,.txt,.md,.docx"
           style="display:none">
    <textarea id="input" rows="1"
      placeholder="Describe the API you want to create…"></textarea>
    <button id="send-btn" title="Send (Enter)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 1.5l13 6.5-13 6.5V9.5l9-1.5-9-1.5V1.5z"/>
      </svg>
    </button>
  </div>
  <div id="hint">Enter to send · Shift+Enter for new line</div>
</div>

<script nonce="${this._nonce}">
const vscode      = acquireVsCodeApi();
let isStreaming   = false;
let hasSession    = false;
let currentAssistantEl = null;

// ── Attachment state ──────────────────────────────────────────────────────
const MAX_ATTACHMENTS  = 5;
let pendingAttachments = [];   // array of { name, type, mimeType, data }

const attachBtn  = document.getElementById('attach-btn');
const fileInput  = document.getElementById('file-input');
const chipsWrap  = document.getElementById('attachment-chips');

attachBtn.addEventListener('click', () => {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) { return; }
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || pendingAttachments.length >= MAX_ATTACHMENTS) { return; }
  const isImage = file.type.startsWith('image/');
  const reader  = new FileReader();
  reader.onload = (ev) => {
    const idx = pendingAttachments.length;
    pendingAttachments.push({
      name:     file.name,
      mimeType: file.type || 'text/plain',
      type:     isImage ? 'image' : (file.name.endsWith('.docx') ? 'docx' : 'text'),
      data:     isImage
                  ? ev.target.result.split(',')[1]
                  : btoa(unescape(encodeURIComponent(ev.target.result))),
    });
    _renderChips();
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      attachBtn.disabled = true;
      attachBtn.title    = 'Maximum 5 attachments reached';
    }
  };
  isImage ? reader.readAsDataURL(file) : reader.readAsText(file);
  e.target.value = '';
});

// Event delegation — handles all chip × buttons (CSP-safe, no onclick in HTML)
chipsWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-idx]');
  if (!btn) { return; }
  const idx = parseInt(btn.getAttribute('data-idx'), 10);
  pendingAttachments.splice(idx, 1);
  _renderChips();
  attachBtn.disabled = pendingAttachments.length >= MAX_ATTACHMENTS;
  attachBtn.title    = 'Attach image or document (max 5)';
});

function _renderChips() {
  chipsWrap.innerHTML = '';
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const icon = a.type === 'image' ? '🖼' : '📄';
    chip.innerHTML =
      \`<span>\${icon} \${escHtml(a.name)}</span>\` +
      \`<button data-idx="\${i}" title="Remove">✕</button>\`;
    chipsWrap.appendChild(chip);
  });
}

function clearAttachments() {
  pendingAttachments = [];
  chipsWrap.innerHTML = '';
  attachBtn.disabled = false;
  attachBtn.title    = 'Attach image or document (max 5)';
}

// ── Send button + keyboard ────────────────────────────────────────────────
document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});


// ── Auto-resize textarea ──────────────────────────────────────────────────
document.getElementById('input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ── New session + publish buttons ─────────────────────────────────────────
document.getElementById('new-session-btn').addEventListener('click', promptNewSession);
document.getElementById('publish-btn').addEventListener('click', publishToAnypoint);

// ── Mode toggle ───────────────────────────────────────────────────────────
document.getElementById('btn-plan').addEventListener('click', () => {
  vscode.postMessage({ type: 'setMode', mode: 'plan' });
});
document.getElementById('btn-act').addEventListener('click', () => {
  vscode.postMessage({ type: 'setMode', mode: 'act' });
});

// ── Approval mode toggle ─────────────────────────────────────────────────
document.getElementById('btn-approval-auto').addEventListener('click', () => {
  vscode.postMessage({ type: 'setApprovalMode', mode: 'auto' });
});
document.getElementById('btn-approval-manual').addEventListener('click', () => {
  vscode.postMessage({ type: 'setApprovalMode', mode: 'manual' });
});

// Event delegation for approval card buttons (CSP-safe, no inline onclick).
// Uses getElementById directly, not the 'messages' const — that binding is
// declared later, in the Rendering section below.
document.getElementById('messages').addEventListener('click', (e) => {
  const btn = e.target.closest('.approval-approve, .approval-reject');
  if (!btn) { return; }
  const requestId = btn.getAttribute('data-request-id');
  const approved  = btn.classList.contains('approval-approve');
  const card = document.querySelector(\`.approval-card[data-request-id="\${requestId}"]\`);
  if (card) {
    card.classList.add('resolved');
    const status = card.querySelector('.approval-card-status');
    if (status) { status.textContent = '⏳ Sending decision…'; }
  }
  vscode.postMessage({ type: 'approvalResponse', requestId, approved });
});

// ── Actions ───────────────────────────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;
  input.value = ''; input.style.height = 'auto';
  const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : [];
  const msg = { type: 'send', text };
  if (atts.length > 0) {
    msg.attachments = atts;
    clearAttachments();
  }
  vscode.postMessage(msg);
}
function promptNewSession() {
  const existing = document.getElementById('new-session-input-row');
  if (existing) { existing.remove(); return; }

  const row = document.createElement('div');
  row.id = 'new-session-input-row';
  row.style.cssText = 'display:flex;gap:6px;padding:6px 12px;background:var(--vscode-input-background);border-top:1px solid var(--vscode-panel-border)';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'Project name…';
  inp.style.cssText = 'flex:1;background:transparent;border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);padding:4px 8px;border-radius:4px;outline:none';

  const btn = document.createElement('button');
  btn.textContent = 'Create';
  btn.style.cssText = 'padding:4px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer';

  const confirm = () => {
    const name = inp.value.trim();
    if (name) { vscode.postMessage({ type: 'newSession', name }); }
    row.remove();
  };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') row.remove();
  });
  btn.addEventListener('click', confirm);

  const cancel = document.createElement('button');
  cancel.textContent = '✕';
  cancel.title = 'Cancel';
  cancel.style.cssText = 'padding:4px 8px;background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-widget-border);border-radius:4px;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0';
  cancel.addEventListener('click', () => row.remove());

  row.appendChild(inp);
  row.appendChild(btn);
  row.appendChild(cancel);

  const inputArea = document.getElementById('input-area');
  inputArea.parentNode.insertBefore(row, inputArea);
  inp.focus();
}
function publishToAnypoint() {
  vscode.postMessage({ type: 'publish' });
}

// ── Rendering ─────────────────────────────────────────────────────────────
const messages = document.getElementById('messages');
function scrollToBottom() { messages.scrollTop = messages.scrollHeight; }

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
function addThinkingStep(tool, label) {
  if (!currentAssistantEl) return;
  const s = document.createElement('div');
  s.className = 'thinking-step';
  s.dataset.tool = tool || '';
  s.innerHTML = \`<span class="dot"></span><span class="spinner"></span><span>\${escHtml(label)}</span>\`;
  currentAssistantEl.thinkingEl.appendChild(s);
  scrollToBottom();
}
function markThinkingDone(tool, summary) {
  if (!currentAssistantEl) return;
  // Try to match by tool name first
  let step = tool
    ? currentAssistantEl.thinkingEl.querySelector(\`.thinking-step[data-tool="\${tool}"]:not(.done)\`)
    : null;
  // Fallback to last undone step
  if (!step) {
    const steps = currentAssistantEl.thinkingEl.querySelectorAll('.thinking-step:not(.done)');
    step = steps[steps.length - 1];
  }
  if (!step) return;
  step.classList.add('done');
  step.querySelector('.spinner')?.remove();
  const lbl = step.querySelector('span:last-child');
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
  b.textContent = \`📄 \${count} file(s) written: \${names}\${extra}\`;
  currentAssistantEl.bubble.appendChild(b); scrollToBottom();
}
function addApprovalCard(requestId, files, deletedFiles) {
  const host = (currentAssistantEl && currentAssistantEl.bubble) || messages;
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.setAttribute('data-request-id', requestId);
  const fileLines = (files || []).map(f => \`+ \${escHtml(f)}\`)
    .concat((deletedFiles || []).map(f => \`- \${escHtml(f)}\`));
  card.innerHTML =
    \`<div class="approval-card-title">🔏 Approval needed — \${(files||[]).length + (deletedFiles||[]).length} file(s)</div>\` +
    \`<div class="approval-card-files">\${fileLines.join('<br>')}</div>\` +
    \`<div class="approval-card-actions">\` +
      \`<button class="approval-approve" data-request-id="\${requestId}">✓ Approve</button>\` +
      \`<button class="approval-reject"  data-request-id="\${requestId}">✕ Reject</button>\` +
    \`</div>\` +
    \`<div class="approval-card-status"></div>\`;
  host.appendChild(card);
  scrollToBottom();
}
function resolveApprovalCard(requestId, approved) {
  const card = document.querySelector(\`.approval-card[data-request-id="\${requestId}"]\`);
  if (!card) { return; }
  card.classList.add('resolved', approved ? 'approved' : 'rejected');
  const status = card.querySelector('.approval-card-status');
  if (status) {
    status.textContent = approved
      ? '✓ Approved — written to workspace'
      : '✕ Rejected — change reverted';
  }
}
function addUserBubble(text, attachments) {
  const d = document.createElement('div');
  d.className = 'msg user';
  let html = \`<div class="bubble">\${escHtml(text)}\`;
  if (attachments && attachments.length > 0) {
    const chips = attachments.map(a => {
      const icon = a.type === 'image' ? '🖼' : '📄';
      return \`<span style="display:inline-block;margin-top:5px;margin-right:4px;
               background:rgba(255,255,255,0.15);border-radius:8px;
               padding:2px 8px;font-size:10px;">\${icon} \${escHtml(a.name)}</span>\`;
    }).join('');
    html += \`<div style="margin-top:4px">\${chips}</div>\`;
  }
  html += '</div>';
  d.innerHTML = html;
  messages.appendChild(d); scrollToBottom();
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
    case 'modeChanged': {
      const btnPlan = document.getElementById('btn-plan');
      const btnAct  = document.getElementById('btn-act');
      btnPlan.classList.toggle('active', msg.mode === 'plan');
      btnAct.classList.toggle('active',  msg.mode === 'act');

      // Apply body-level theme so the whole UI shifts colour
      document.body.classList.toggle('mode-plan', msg.mode === 'plan');
      document.body.classList.toggle('mode-act',  msg.mode === 'act');

      // Update hint bar text + class
      const hint = document.getElementById('mode-hint');
      hint.className = msg.mode;
      hint.textContent = msg.mode === 'plan'
        ? '📋 Plan mode — describe what to build. No files will be written yet.'
        : '🎯 Act mode — your message will trigger file generation in the workspace';
      break;
    }
    case 'approvalModeChanged': {
      document.getElementById('btn-approval-auto').classList.toggle('active', msg.mode === 'auto');
      document.getElementById('btn-approval-manual').classList.toggle('active', msg.mode === 'manual');
      break;
    }
    case 'approvalRequest':
      addApprovalCard(msg.requestId, msg.files, msg.deletedFiles);
      break;
    case 'approvalResolved':
      resolveApprovalCard(msg.requestId, msg.approved);
      break;
    case 'sessionStarted':
      hasSession = true;
      // Reset token bar for new session
      const f = document.getElementById('token-fill');
      const l = document.getElementById('token-label');
      if (f) { f.style.width = '0%'; f.style.background = 'var(--vscode-charts-green)'; }
      if (l) { l.textContent = '0 / 35,000'; }
      // Re-enable input in case it was disabled by token_limit
      const i = document.getElementById('input');
      const s = document.getElementById('send-btn');
      if (i) { i.disabled = false; i.placeholder = 'Describe the API you want to create…'; }
      if (s) { s.disabled = false; }
      document.getElementById('session-label').textContent = \`📁 \${msg.projectName}\`;
      document.getElementById('publish-btn').disabled = false;
      addSystemBubble(msg.isNew
    ? \`New session: **\${msg.projectName}**\`
    : \`Resumed **\${msg.projectName}**\`);
      break;
    case 'userMessage':    addUserBubble(msg.text, msg.attachments || []); break;
    case 'assistantStart': startAssistantBubble(); break;
    case 'thinking': addThinkingStep(msg.tool, msg.label); break;
    case 'toolDone': markThinkingDone(msg.tool, msg.summary); break;
    case 'filesWritten':   addFilesBadge(msg.count, msg.changedFiles); break;
    case 'validation':     addValidationBadge(msg.valid, msg.error_count, msg.warning_count); break;
    case 'assistantMessage': setAssistantContent(msg.text); break;
    case 'systemMessage':  addSystemBubble(msg.text); break;
    case 'tokenUpdate': {
      const fill  = document.getElementById('token-fill');
      const label = document.getElementById('token-label');
      if (!fill || !label) break;
      fill.style.width = msg.pct + '%';
      fill.style.background =
          msg.level === 'danger' ? 'var(--vscode-charts-red)'   :
          msg.level === 'warn'   ? 'var(--vscode-charts-yellow)' :
                                    'var(--vscode-charts-green)';
      label.textContent =
          msg.tokens.toLocaleString() + ' / ' +
          msg.max_tokens.toLocaleString();
      break;
  }
    case 'tokenLimit': {
        const inp = document.getElementById('input');
        const btn = document.getElementById('send-btn');
        if (inp) { inp.disabled = true; inp.placeholder = 'Session full — start a new session'; }
        if (btn) { btn.disabled = true; }
        const d = document.createElement('div');
        d.className = 'msg system';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = \`<div style="margin-bottom:8px;font-size:12px;">
            <strong>Session Summary</strong><br>\${escHtml(msg.summary)}
        </div>\`;
        const newBtn = document.createElement('button');
        newBtn.textContent = '🔄 Start New Session';
        newBtn.style.cssText = 'width:100%;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px';
        newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession', name: '' }));
        bubble.appendChild(newBtn);
        d.appendChild(bubble);
        messages.appendChild(d);
        scrollToBottom();
        break;
    }
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