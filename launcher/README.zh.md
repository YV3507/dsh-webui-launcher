# DeepSeek Harness Web UI — Windows 快捷启动

[English](README.md) | 中文

面向 Windows 的 DeepSeek Harness Web UI 双击启动器。它静默地在后台启动 `dsh --profile web`，用系统默认浏览器打开 Web UI，并在所有打开过 Web UI 的浏览器关闭后停止由它启动的 harness。[Agent Note](../../.agents/notes/implemented/process/2026-08-15-windows-quick-launch.zh.md) 记录了设计决策。

## 目录内容

- `dsh-webui.vbs` — 双击入口；隐藏运行看门狗，仅在失败时弹出提示框。
- `dsh-webui.ps1` — 看门狗：启动服务器、打开浏览器、监视浏览器到 Web UI 端口的 TCP 连接，并停止 harness。
- `install-shortcut.ps1` — 在桌面（及可选的开始菜单）安装名为 "DeepSeek Harness Web UI" 的快捷方式，指向 `dsh-webui.vbs`。
- `dsh-webui.ico` / `dsh-webui-dark.ico` — 快捷方式图标，由 Web UI 的 favicon（`apps/web/public/favicon.svg`）渲染而来：黑色标记用于浅色桌面，白色标记用于深色桌面。
- `build-icon.ps1` — 从 SVG 重新生成 .ico（需要 Microsoft Edge；`-ColorScheme dark` 生成白色标记）。

## 安装

双击 `dsh-webui.vbs`，或用以下命令安装应用风格的快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-shortcut.ps1 -StartMenu
```

快捷方式图标为 dsh 标记（`dsh-webui.ico`）；深色桌面可传 `-IconPath scripts\windows\dsh-webui-dark.ico` 使用白色标记，或用 `build-icon.ps1` 重新生成。随时可再次运行快捷方式（或 .vbs）；即使已有另一个实例在服务 Web UI 也能正常工作。

## 分发

在 deepseek-harness 检出目录之外安装时，看门狗通过 `-ShRoot` 或脚本旁的 `dsh-webui.json` 配置文件（`{ "shRoot": "<路径>" }`）解析 dsh 根目录，且同时接受检出根目录与 npm 风格的 `@deepseek-ai/dsh` 包目录。本启动器的独立、MIT 许可分发版（一键安装器、GitHub Actions 发布 zip）位于独立仓库，见其顶层 README。

## 工作原理

看门狗启动与 `pnpm dsh --profile web` 相同的命令（`node apps/cli/lib/bin.js`，没有构建产物时退化为 tsx 源码启动器），等待端口应答 HTTP，然后在默认浏览器中打开 `http://127.0.0.1:<port>`，此后每两秒轮询一次。启动慢不算失败：只要服务器进程仍存活，看门狗就周期性警告并继续等待，仅在进程退出且无兄弟接管端口时才判定失败。

只要有一个浏览器与 Web UI 端口保持已建立的 TCP 连接，harness 就保持运行；页面在标签页打开期间会维持其 `/api/events.mux` WebSocket。在浏览器首次连接之前，使用更长的宽限（默认 60 秒，`-FirstConnectGraceSeconds`），避免把慢速页面加载误判为浏览器已关闭；首次连接之后按正常宽限检测关闭。当所有此类连接在宽限期内（默认 6 秒，`-ShutdownGraceSeconds`）消失时，看门狗用 `taskkill /T /F` 停止 harness 进程树并退出。

端口上已有服务器时采用"接管"模式：不重启、也绝不停止；看门狗只关闭它自己启动的 harness，因此不会误杀以其他方式启动的服务器。两个几乎同时的启动会共享一台服务器：落败实例的 harness 因端口被占而退出，其看门狗改为接管胜出实例而不是报错。被接管的服务器消失属于正常观察结束，静默退出。

## 配置

默认值以参数形式位于 `dsh-webui.ps1` 顶部：`-Port`（3080）、`-HostAddress`（127.0.0.1）、`-ShRoot`（dsh 根目录；默认从脚本位置或 `dsh-webui.json` 配置文件推导）、`-Launch`（`auto` 优先内置 CLI，否则用 tsx 源码启动）、`-StartupTimeoutSeconds`（120；每次"启动缓慢"警告的间隔——看门狗绝不杀死仍存活的服务器）、`-FirstConnectGraceSeconds`（60；浏览器尚未连接时的容忍时长）、`-BrowserObservationSeconds`（30）、`-ShutdownGraceSeconds`（6）、`-LogDir`（脚本旁的 `logs` 目录）、`-DshHome`（继承环境中的 `DSH_HOME`）。一次性运行可通过快捷方式或控制台传入；永久修改请直接编辑文件中的默认值。无效的 `-Port`（超出 1..65535）或 `-HostAddress`（不是主机名/IP 字面量，或为 `0.0.0.0`）会在启动任何东西之前快速失败。`-SelfTest` 打印诊断信息后退出；`-NoBrowser` 只监视不打开浏览器；`-AdoptOnly` 只监视已有服务器，既不启动也不停止。

## 安全性

启动器仅以调用用户的权限运行：不要求管理员权限或 UAC，不涉及注册表、系统服务、计划任务或全局环境变量，也不读取或保存任何凭据。它只写入已 gitignore 的 `scripts/windows/logs` 目录、harness 的 `DSH_HOME`，以及（安装器）用户桌面。harness 仅绑定回环地址（`127.0.0.1`）——`0.0.0.0` 在此处与 `dsh web` 本身都会拒绝——启动器本身不打开任何外部网络连接。

唯一的破坏性原语是关停时的杀进程，且受到严格约束：看门狗只终止它自己启动的进程树，并且在终止前验证该 PID 仍属于该进程（进程名与启动时间）；被复用的 PID 不会被触碰，被接管的服务器也从不被杀。`netstat` 与 `taskkill` 通过 `%SystemRoot%\System32` 绝对路径调用，避免 PATH 劫持；`node` 与其他启动器一样按 PATH 解析，解析出的路径会写入日志。

## 日志与失败提示

看门狗与服务器日志累积在 `scripts/windows/logs` 下（已加入 gitignore）。退出码 1（以及 .vbs 弹窗）只用于启动失败或自启 harness 崩溃；正常生命周期——浏览器关闭并停止自启 harness，或被接管服务器继续运行或消失——都以退出码 0 静默结束。

## 已知限制

关闭方式是强杀（`taskkill /T /F`），harness 没有优雅退出流程；会话日志是追加写的，不会丢失。关闭最后一个 Web UI 标签页同样会停止 harness，因为连接由标签页持有。从未连接到该端口（页面从未加载）的浏览器不会让 harness 保持运行。
