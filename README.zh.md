# DeepSeek Harness Web UI — Windows 快捷启动

面向 Windows 的 DeepSeek Harness Web UI 双击启动器。它静默地在后台启动 `dsh --profile web`，用系统默认浏览器打开 Web UI，并在所有打开过 Web UI 的浏览器关闭后停止由它启动的 harness。

## 安装

需要 Windows 10/11 与 Node.js 22 或更高版本。用 PowerShell 运行安装器：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

或直接双击 `install.cmd`。安装器按以下顺序定位 dsh：`-ShRoot` 参数、`DSH_ROOT` 环境变量、安装器旁的发布 zip 中的 `runtime\` 目录、以及全局 npm 安装的 `@deepseek-ai/dsh`。都找不到时会打印先安装什么（deepseek-harness 源码检出，或发布后的 `npm install -g @deepseek-ai/dsh`）。

源码检出若尚未构建 CLI，安装器会自动构建（`pnpm install && pnpm run build`），除非传入 `-SkipBuild`。

安装完成后，桌面会出现 "DeepSeek Harness Web UI" 快捷方式；需要开始菜单入口请加 `-StartMenu`。

## 发布 zip

GitHub Releases 中的 `dsh-webui-launcher-windows-<ref>.zip` 自包含：解压到任意位置后运行 `install.cmd` 即可。zip 内的 `runtime\` 目录是预构建的 dsh 运行时，无需源码检出或等待 npm 发布。`release` 工作流会在 Windows 上从 harness 仓库构建并附带发布。

## 工作原理

看门狗启动 `dsh --profile web`（优先内置 CLI，源码检出时回退 tsx 源码启动器），等待端口应答 HTTP，在默认浏览器中打开 `http://127.0.0.1:<port>`，此后每两秒轮询一次。只要有一个浏览器与 Web UI 端口保持已建立的 TCP 连接，harness 就保持运行；当所有连接在宽限期（默认 6 秒）内消失时，看门狗停止由它启动的 harness 进程树并退出。端口上已有服务器时采用接管模式，不重启也绝不停止。配置与安全说明见 `launcher/README.md`。

## 目录结构

- `launcher/` — 看门狗（`dsh-webui.ps1`）、静默入口（`dsh-webui.vbs`）、快捷方式安装器、图标构建器与图标、逐文件文档。
- `install.ps1` / `install.cmd` — 一键安装器。
- `.github/workflows/release.yml` — 在 Windows 上构建 harness 并发布自包含 zip。

## 安全性

启动器仅以调用用户权限运行：不提权、不改注册表或系统服务、不连外网、仅绑定回环地址，并且只终止自己启动的进程树（杀前验证 PID 仍属于该进程）。详见 `launcher/README.md`。

## 卸载

删除桌面快捷方式与启动器目录（默认 `%LOCALAPPDATA%\dsh-webui-launcher`）。dsh 安装本身不受影响。

## License

MIT
