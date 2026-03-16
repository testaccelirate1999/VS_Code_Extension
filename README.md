# Dev Agent — VS Code Extension

Copilot-style AI assistant for MuleSoft development. Generates RAML, DataWeave,
and Mule Flow files directly into your workspace.

## Project layout

```
Dev_Agent/               ← your agent repo root
├── server.py            ← Python FastAPI server  ← ADD THIS FILE HERE
├── agent.py
├── prompts.py
├── raml_agent/
├── dataweave_agent/
├── mule_flow_agent/
└── shared/

vscode-extension/        ← this extension (separate folder)
├── src/
│   ├── extension.ts
│   ├── chatPanel.ts
│   ├── fileWriter.ts
│   └── serverManager.ts
├── media/icon.svg
├── package.json
└── tsconfig.json
```

## Setup

### 1. Add server.py to your Dev_Agent folder
Copy `server.py` into `Dev_Agent/` (same level as `agent.py`).

### 2. Install Python dependencies
```bash
cd Dev_Agent
pip install uvicorn sqlalchemy
```

### 3. Build the extension
```bash
cd vscode-extension
npm install
npm run compile
```

### 4. Run the extension in VS Code
- Open the `vscode-extension` folder in VS Code
- Press **F5** to launch Extension Development Host
- The Dev Agent icon appears in the Activity Bar (left sidebar)

### 5. Start the server
Either:
- Click **"Start Server"** in the Dev Agent panel, OR
- Run manually: `cd Dev_Agent && python server.py`

### 6. Start chatting
- Click **＋ New Session** and give your project a name
- Type your request: `"Create an Orders REST API with pagination"`
- Files are written automatically to your workspace folder

## Configuration

In VS Code settings (`Ctrl+,`, search "devAgent"):

| Setting | Default | Description |
|---------|---------|-------------|
| `devAgent.serverUrl` | `http://localhost:8001` | Python server URL |
| `devAgent.outputFolder` | *(empty)* | Subfolder to write files into. Empty = workspace root |

## How it works

```
You type in the panel
        ↓
Extension POSTs to server.py /chat (SSE stream)
        ↓
server.py → ADK Runner → dev_agent → raml_agent
        ↓
raml_agent tools generate files into SessionStore
        ↓
"files" SSE event sent back to extension
        ↓
fileWriter.ts writes files into VS Code workspace
        ↓
First file auto-opens in editor
```
