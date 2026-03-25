// src/fileWriter.ts
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export class FileWriter {
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  async writeFiles(
    files: Record<string, string>,
    changedFiles: string[],
    deletedFiles: string[]
  ): Promise<string[]> {
    if (!this.workspaceRoot) {
      vscode.window.showErrorMessage(
        "Dev Agent: No workspace folder open. Open a folder first."
      );
      return [];
    }

    const written: string[] = [];

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
      if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); }
    }

    if (written.length > 0) {
      const uri = vscode.Uri.file(written[0]);
      await vscode.window.showTextDocument(uri, {
        preview: false, viewColumn: vscode.ViewColumn.One,
      });
    }

    return written;
  }

  showFilesNotification(written: string[]) {
    if (written.length === 0) { return; }
    const names = written.map((f) => path.basename(f)).slice(0, 3).join(", ");
    const extra = written.length > 3 ? ` +${written.length - 3} more` : "";
    vscode.window.showInformationMessage(
      `Dev Agent wrote ${written.length} file(s): ${names}${extra}`,
      "Open Folder"
    ).then((choice) => {
      if (choice === "Open Folder") {
        vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(written[0]));
      }
    });
  }
}