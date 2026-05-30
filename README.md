# GemSync Manager

GemSync Manager is a local Windows tool for studying with Gemini and PDFs side by side.

It does three things:

1. Converts course PPT/PDF files into page screenshots.
2. Sends those screenshots to Gemini one page at a time with your prompt.
3. Writes a Chrome extension config so Gemini can open a synced PDF panel next to the chat.

This public repo only contains the app and extension source code. Your course PDFs, Gemini conversation links, logs, and generated configs are local files and are ignored by git.

## What You Need

- Windows 10/11
- Node.js 20 or newer
- Google Chrome
- Python 3, available as `python`
- Poppler command line tools, especially `pdftoppm` and `pdfinfo`
- LibreOffice, only needed when converting PPT/PPTX files
- A Gemini account logged in inside the automation Chrome profile

Install Node dependencies:

```powershell
npm install
```

If `pdftoppm`, `pdfinfo`, `python`, or `node` are not on PATH, set environment variables before starting:

```powershell
$env:GEMSYNC_NODE = "C:\Path\To\node.exe"
$env:GEMSYNC_PYTHON = "C:\Path\To\python.exe"
$env:GEMSYNC_PDFTOPPM = "C:\Path\To\pdftoppm.exe"
$env:GEMSYNC_PDFINFO = "C:\Path\To\pdfinfo.exe"
```

## Start The Manager

From this folder:

```powershell
.\start.ps1
```

Or:

```powershell
npm start
```

Open:

```text
http://127.0.0.1:5188
```

## Install The Chrome Extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click **Load unpacked**.
4. Select this folder:

```text
<repo>\extension
```

Refresh Gemini after loading or reloading the extension.

## Basic Workflow

1. Start GemSync Manager.
2. Choose a course folder that contains your PPT/PDF files.
3. Click **Scan Folder**.
4. Click **Prepare Screenshots** if screenshots do not exist yet.
5. Click **Open Gemini Tab** and log in once if needed.
6. Choose the Gemini model and prompt.
7. Click **Start Gemini Auto Ask**.
8. After Gemini finishes, click **Write To Extension**.
9. Reload the Chrome extension.
10. Open Gemini and use the floating `PDF` button to open the side PDF panel.

## Local Files That Are Not Uploaded

These are intentionally ignored:

- `logs/`
- `outputs/`
- `extension/pdf-panel/subjects.json`
- `extension/pdf-panel/subjects/`
- `gemini_ppt_screenshots_full/`
- local `.env` files

That means public GitHub users get the clean app, not your course records.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `GEMSYNC_MANAGER_PORT` | Manager port. Default: `5188`. |
| `GEMSYNC_NODE` | Node executable used by background jobs. Default: current Node or `node`. |
| `GEMSYNC_PYTHON` | Python executable used for PPT conversion helpers. Default: `python`. |
| `GEMSYNC_PDFINFO` | Path to `pdfinfo`. Default: `pdfinfo`. |
| `GEMSYNC_PDFTOPPM` | Path to `pdftoppm`. Default: `pdftoppm`. |
| `GEMSYNC_AUTOMATION_SCRIPTS` | Folder containing automation scripts. Default: `<repo>\scripts`. |
| `GEMSYNC_DEFAULT_WORKSPACE` | Optional default course folder. |
| `GEMSYNC_DEFAULT_PROMPT` | Optional default prompt. |

## Chrome Automation

Gemini automation connects to Chrome DevTools at:

```text
http://127.0.0.1:9222
```

The manager can open an automation Chrome tab for you. If you start Chrome manually, use:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\gemsync-chrome" https://gemini.google.com/app
```

Log in to Gemini once in that Chrome profile.

## Notes

- Do not manually click Gemini send while the automation is running.
- If a run fails, you can run it again. Progress is stored in the selected course folder.
- PDF/PPT files stay local unless you explicitly send their screenshots to Gemini.
