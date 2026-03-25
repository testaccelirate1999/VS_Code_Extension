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
exports.FileWriter = void 0;
// src/fileWriter.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class FileWriter {
    constructor() {
        this.workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    }
    async writeFiles(files, changedFiles, deletedFiles) {
        if (!this.workspaceRoot) {
            vscode.window.showErrorMessage("Dev Agent: No workspace folder open. Open a folder first.");
            return [];
        }
        const written = [];
        for (const [relativePath, content] of Object.entries(files)) {
            if (changedFiles.length > 0 && !changedFiles.includes(relativePath)) {
                continue;
            }
            const fullPath = path.join(this.workspaceRoot, relativePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, "utf8");
            written.push(fullPath);
        }
        for (const relativePath of deletedFiles) {
            const fullPath = path.join(this.workspaceRoot, relativePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }
        if (written.length > 0) {
            const uri = vscode.Uri.file(written[0]);
            await vscode.window.showTextDocument(uri, {
                preview: false, viewColumn: vscode.ViewColumn.One,
            });
        }
        return written;
    }
    showFilesNotification(written) {
        if (written.length === 0) {
            return;
        }
        const names = written.map((f) => path.basename(f)).slice(0, 3).join(", ");
        const extra = written.length > 3 ? ` +${written.length - 3} more` : "";
        vscode.window.showInformationMessage(`Dev Agent wrote ${written.length} file(s): ${names}${extra}`, "Open Folder").then((choice) => {
            if (choice === "Open Folder") {
                vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(written[0]));
            }
        });
    }
}
exports.FileWriter = FileWriter;
