# dsh-webui-launcher — DeepSeek Harness 跨平台 Web UI 启动器插件

[English](README.md) | 中文

一个从 harness 内部启动、停止、检查并打开 DeepSeek Harness Web UI 的 DSH 插件——跨平台（Windows / macOS / Linux），无需任何桌面脚本。

## 安装

```sh
dsh plugin --profile web add github:YV3507/dsh-webui-launcher
```

或从本地检出安装：

```sh
cd dsh-webui-launcher
npm install && npm run build
dsh plugin --profile web add .
```

## 提供的能力

- 模型工具 `webui.status` / `webui.start` / `webui.stop` / `webui.open`——后台启动 Web UI（spawn `dsh --profile web`）、等待 HTTP 200、查询或停止、打开默认浏览器。
- `/webui start|stop|status|open` 斜杠命令。
- Web UI 设置页上的「Web UI 启动器」卡片（浏览器半，`exports["./client"]`），驱动同一组 `/webui/*` JSON 端点。
- **桌面快捷方式**：首次启动插件时在桌面自动创建启动器快捷方式（Windows `.lnk` / Linux `.desktop` / macOS `.command`），双击后启动 Web UI 并在就绪时打开浏览器。无头主机（无桌面、无 DISPLAY）会静默跳过——插件在服务器上绝不会因此崩溃。可用 `desktopShortcut: false` 关闭。
- **自定义快捷方式图标**：在设置卡片上传任意图片（PNG/JPEG/BMP/GIF/TIFF），自动转换（Windows 生成多尺寸 `.ico`，Linux 生成 `.png`）并立即更新已有快捷方式的图标；若尚未创建快捷方式（无头/已禁用），转换后的图标仍会保存，供将来创建时使用。
- 插件配置：`port`（默认 3080）、`host`（127.0.0.1）、`cliBin`（"" = 复用当前运行的 CLI）、`startupTimeoutMs`（120000）、`openBrowserOnStart`（true）、`desktopShortcut`（true）、`shortcutName`（"DeepSeek Harness Web UI"）、`shortcutIconPath`（"" = 快捷方式的显式图标图片）。

## 行为与健壮性

- **接管或启动**：端口上已有服务器时只接管——不重启、绝不停止。`webui.stop` 只终止本插件 spawn 的进程树。
- **显式状态机**：`idle → starting → running → stopping`，单飞串行化——并发 `start`/`stop` 永不交错。
- **孤儿清理**：插件卸载或热重载时，停止其 spawn 的服务器（`ctx.effect` dispose）。
- **PID 身份防护**：杀进程前重新核验（存活、仍是本插件子进程，Windows 下经 tasklist 确认仍是 node.exe），绝不动被复用的 PID。
- **中止/超时卫生**：被中止或超时的 start 会杀掉自己 spawn 的子进程，并在错误信息中带上输出尾部。
- **CLI 定位兜底链**：当前运行中的 CLI（`process.argv[1]`）→ `@deepseek-ai/dsh` 包 → 显式 `cliBin` 配置；找不到时报可操作错误。

## 开发

```sh
npm run build    # esbuild → lib/index.js（宿主）+ lib/client.js（浏览器）
npm test         # node --test，零依赖（mock 两个外部包）
```

状态机的失败路径（子进程死亡、超时、中止、兄弟接管、并发、卸载清理）通过脚本化假依赖对构建产物做单元测试——不涉及真实进程与计时器。

## 安全性

默认仅回环地址，不提权、不连外网。插件只终止自己 spawn 的进程树，且杀前核验 PID 仍属于该进程。

## License

MIT
