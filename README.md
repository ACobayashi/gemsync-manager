# GemSync Manager

GemSync Manager 是一个本地学习工具，用来把 Gemini 聊天记录和 PDF/PPT 页面同步到一起看。

它主要做三件事：

1. 把课程里的 PPT、PPTX 或 PDF 转成逐页截图。
2. 自动把每一页截图发给 Gemini，让 Gemini 按你的提示词讲解。
3. 生成 Chrome 插件配置，让你在 Gemini 页面旁边打开同步 PDF 面板。

这个公开仓库只包含程序源码、插件源码和示例配置。你的课程文件、Gemini 对话链接、日志、截图和本地配置都会留在你电脑上，不会被上传到 GitHub。

## 需要的环境

- Windows 10/11
- Node.js 20 或更新版本
- Google Chrome
- Python 3，并且命令行里能运行 `python`
- Poppler 命令行工具，至少需要 `pdftoppm` 和 `pdfinfo`
- LibreOffice，只在需要转换 PPT/PPTX 时使用
- 一个可以正常登录 Gemini 的账号

## 一键配置环境

推荐先运行环境配置脚本：

```powershell
.\scripts\setup-env.ps1
```

这个脚本会自动做这些事：

1. 检测 Node.js、Python、Poppler、LibreOffice 和 Chrome。
2. 已经安装的环境会直接复用。
3. 缺少的环境会提示你是否用 `winget` 安装。
4. 自动写入 GemSync 需要的环境变量。
5. 生成本地配置文件 `.gemsync.local.ps1`。
6. 自动运行 `npm install` 安装项目依赖。

如果你想不再逐个确认，直接安装缺少的环境：

```powershell
.\scripts\setup-env.ps1 -InstallMissing
```

如果你只想检查，不安装也不写入环境变量：

```powershell
.\scripts\setup-env.ps1 -CheckOnly
```

脚本生成的 `.gemsync.local.ps1` 只保存在你的电脑上，已经被 `.gitignore` 忽略，不会上传到 GitHub。

## 手动配置环境

如果你不想用上面的脚本，也可以手动安装依赖。

安装 Node 依赖：

```powershell
npm install
```

如果 `node`、`python`、`pdftoppm` 或 `pdfinfo` 没有加入 PATH，可以在启动前设置环境变量：

```powershell
$env:GEMSYNC_NODE = "C:\Path\To\node.exe"
$env:GEMSYNC_PYTHON = "C:\Path\To\python.exe"
$env:GEMSYNC_PDFTOPPM = "C:\Path\To\pdftoppm.exe"
$env:GEMSYNC_PDFINFO = "C:\Path\To\pdfinfo.exe"
$env:GEMSYNC_CHROME = "C:\Path\To\chrome.exe"
```

## 启动管理器

在仓库目录下运行：

```powershell
.\start.ps1
```

也可以运行：

```powershell
npm start
```

然后打开：

```text
http://127.0.0.1:5188
```

## 安装 Chrome 插件

1. 打开 `chrome://extensions`。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择这个目录：

```text
<repo>\extension
```

加载或重新加载插件后，刷新 Gemini 页面。

## 基本使用流程

1. 启动 GemSync Manager。
2. 选择一门课所在的文件夹，里面可以放 PPT、PPTX 或 PDF。
3. 点击“扫描文件夹”。
4. 如果还没有截图，点击“准备截图”。
5. 点击“打开 Gemini 标签页”，第一次使用时先登录 Gemini。
6. 选择 Gemini 模型，并确认提示词。
7. 点击“启动 Gemini 自动问”。
8. 等 Gemini 全部讲完后，点击“写入插件”。
9. 重新加载 Chrome 插件。
10. 打开 Gemini 页面，点击悬浮的 `PDF` 按钮，就可以在旁边看同步 PDF 面板。


## 环境变量

| 变量 | 作用 |
| --- | --- |
| `GEMSYNC_MANAGER_PORT` | 管理器端口，默认是 `5188`。 |
| `GEMSYNC_NODE` | 后台任务使用的 Node 程序，默认使用当前 Node 或 `node`。 |
| `GEMSYNC_PYTHON` | PPT 转截图辅助脚本使用的 Python，默认是 `python`。 |
| `GEMSYNC_PDFINFO` | `pdfinfo` 的路径，默认是 `pdfinfo`。 |
| `GEMSYNC_PDFTOPPM` | `pdftoppm` 的路径，默认是 `pdftoppm`。 |
| `GEMSYNC_CHROME` | Chrome 程序路径，默认会尝试找常见安装位置。 |
| `GEMSYNC_AUTOMATION_SCRIPTS` | 自动化脚本目录，默认是 `<repo>\scripts`。 |
| `GEMSYNC_DEFAULT_WORKSPACE` | 可选，默认课程文件夹。 |
| `GEMSYNC_DEFAULT_PROMPT` | 可选，默认重复发送给 Gemini 的提示词。 |

## Chrome 自动化说明

Gemini 自动提问需要连接 Chrome DevTools，默认地址是：

```text
http://127.0.0.1:9222
```

管理器可以帮你打开自动化 Chrome 标签页。如果你想手动启动 Chrome，可以使用：

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\gemsync-chrome" https://gemini.google.com/app
```

第一次使用时，需要在这个 Chrome 配置里登录 Gemini。

## 使用提醒

- 自动提问运行时，不要手动点击 Gemini 的发送按钮。
- 如果中途失败，可以重新运行，进度会保存在你选择的课程文件夹里。
- PDF/PPT 文件本身不会自动上传到 GitHub。只有当你启动 Gemini 自动问时，程序才会把页面截图发给 Gemini。
