// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import process6 from "node:process";

// src/cli.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import process from "node:process";
function looksLikeCliScript(p) {
  const name2 = basename(p);
  return name2 === "bin.js" || name2 === "bin.ts" || /(^|[\\/])apps[\\/]cli[\\/]/.test(p) || /(^|[\\/])lib[\\/]bin\.(js|ts)$/.test(p);
}
function resolveCliScript(cliBin, argvScript) {
  if (cliBin !== "") return cliBin;
  const argv = argvScript ?? process.argv[1];
  if (typeof argv === "string" && argv !== "" && looksLikeCliScript(argv)) return argv;
  try {
    const require2 = createRequire(import.meta.url);
    const pkgJson = require2.resolve("@deepseek-ai/dsh/package.json");
    const script = join(dirname(pkgJson), "lib", "bin.js");
    if (existsSync(script)) return script;
  } catch {
  }
  throw new Error(
    "could not locate the dsh CLI: pass cliBin in the plugin config, or install dsh-webui-launcher inside a dsh profile"
  );
}
function resolveWorkingDir(cliScript) {
  let dir = dirname(cliScript);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@deepseek-ai/dsh") return dir;
      } catch {
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(cliScript);
}
function resolveCli(cliBin, argvScript) {
  const script = resolveCliScript(cliBin, argvScript);
  if (script.endsWith(".ts")) {
    return { command: process.execPath, prefixArgs: ["--import", "tsx/esm"], entry: script, cwd: resolveWorkingDir(script) };
  }
  if (/\.(js|cjs|mjs)$/.test(script)) {
    return { command: process.execPath, prefixArgs: [], entry: script, cwd: resolveWorkingDir(script) };
  }
  return { command: script, prefixArgs: [], entry: script, cwd: dirname(script) };
}

// src/endpoints.ts
var MAX_ICON_BYTES = 8 * 1024 * 1024;
function isLocalOrigin(req) {
  for (const name2 of ["origin", "referer"]) {
    const value = req.headers[name2];
    if (value === void 0) continue;
    try {
      const host = new URL(Array.isArray(value) ? value[0] : value).hostname;
      if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") continue;
    } catch {
    }
    return false;
  }
  return true;
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function readBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > cap) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflow ? "" : Buffer.concat(chunks).toString("utf8")));
  });
}
function registerWebUiEndpoints(webServer, runtime, iconUpload) {
  const aborters = /* @__PURE__ */ new Set();
  const handlers = {
    status: async () => {
      const status = await runtime.status();
      return { message: status.ready ? `Web UI ready at ${status.url}` : `nothing serving ${status.url}`, status };
    },
    start: async (signal) => runtime.start(signal),
    stop: async () => runtime.stop(),
    open: async () => runtime.open(),
    icon: async (_signal, body) => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return { ok: false, message: "invalid JSON body" };
      }
      if (typeof parsed.data !== "string" || parsed.data === "") {
        return { ok: false, message: "missing base64 image data" };
      }
      const bytes = Buffer.from(parsed.data, "base64");
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
        return { ok: false, message: `image size must be between 1 and ${Math.round(MAX_ICON_BYTES / 1024 / 1024)} MiB` };
      }
      return iconUpload(bytes, typeof parsed.name === "string" ? parsed.name : "icon");
    }
  };
  const disposers = Object.keys(handlers).map(
    (verb) => webServer.register({
      kind: "exact",
      path: `/webui/${verb}`,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        if (!isLocalOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "forbidden: non-local origin" });
          return;
        }
        const controller = new AbortController();
        aborters.add(controller);
        req.once("close", () => {
          aborters.delete(controller);
          controller.abort();
        });
        try {
          const body = verb === "icon" ? await readBody(req, MAX_ICON_BYTES * 2) : "";
          const result = await handlers[verb](controller.signal, body);
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 200, { ok: false, error: message });
        } finally {
          aborters.delete(controller);
        }
      }
    })
  );
  return () => {
    for (const controller of aborters) controller.abort();
    for (const dispose of disposers) dispose();
  };
}

// src/icon.ts
var ICON_SIZES = [16, 32, 48, 64, 128, 256];
function packIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  for (let i = 0; i < count; i += 1) {
    const { size, data } = pngs[i];
    const entry = entries.subarray(i * 16, (i + 1) * 16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
  }
  return Buffer.concat([header, entries, ...pngs.map((png) => png.data)]);
}
async function convertImageToIcon(input) {
  let Jimp;
  try {
    ({ Jimp } = await import("jimp"));
  } catch {
    throw new Error('icon conversion requires the "jimp" package, which is missing \u2014 reinstall dsh-webui-launcher with its dependencies');
  }
  const image = await Jimp.read(input);
  const pngs = [];
  for (const size of ICON_SIZES) {
    const resized = image.clone().resize({ w: size, h: size });
    const data = await resized.getBuffer("image/png");
    pngs.push({ size, data });
  }
  return { ico: packIco(pngs), png: pngs[pngs.length - 1].data };
}

// src/shortcut.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
import process3 from "node:process";

// src/desktop.ts
import { execFile } from "node:child_process";
import { chmodSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import process2 from "node:process";
function detectDesktopDir() {
  const platform = process2.platform;
  if (platform === "win32") {
    const home = process2.env.USERPROFILE ?? homedir();
    for (const candidate of [join2(home, "Desktop"), join2(home, "OneDrive", "Desktop")]) {
      if (existsSync2(candidate)) return candidate;
    }
    return null;
  }
  if (platform === "darwin") {
    const dir2 = join2(homedir(), "Desktop");
    return existsSync2(dir2) ? dir2 : null;
  }
  if (!process2.env.DISPLAY && !process2.env.WAYLAND_DISPLAY) return null;
  const xdg = process2.env.XDG_DESKTOP_DIR;
  if (xdg !== void 0 && xdg !== "" && existsSync2(xdg)) return xdg;
  const dir = join2(homedir(), "Desktop");
  return existsSync2(dir) ? dir : null;
}
function shQuote(value) {
  return value.replaceAll('"', '\\"');
}
function writeLauncherScript(managedDir, spec) {
  mkdirSync(managedDir, { recursive: true });
  const args = spec.cliArgs.map(shQuote).join(" ");
  const commandLine = `"${shQuote(spec.command)}" ${args}`;
  if (process2.platform === "win32") {
    const path2 = join2(managedDir, "launch.cmd");
    writeFileSync(path2, [
      "@echo off",
      "setlocal",
      `start "DeepSeek Harness Web UI" /min ${commandLine}`,
      ":loop",
      `>nul 2>&1 powershell -NoProfile -Command "$r = try { (Invoke-WebRequest -UseBasicParsing -Uri '${spec.url}/' -TimeoutSec 2).StatusCode } catch { 0 }; exit ($r -eq 200)"`,
      "if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto loop )",
      `start "" "${spec.url}"`,
      "endlocal",
      ""
    ].join("\r\n"), "utf8");
    return path2;
  }
  const path = join2(managedDir, "launch.sh");
  const opener = process2.platform === "darwin" ? "open" : "xdg-open";
  writeFileSync(path, [
    "#!/bin/sh",
    `# ${spec.name} launcher (generated by dsh-webui-launcher)`,
    `${commandLine} &`,
    "i=0",
    "while [ $i -lt 120 ]; do",
    `  if curl -sf "${spec.url}/" -o /dev/null; then break; fi`,
    "  sleep 1",
    "  i=$((i+1))",
    "done",
    `${opener} "${spec.url}" >/dev/null 2>&1 &`,
    ""
  ].join("\n"), "utf8");
  chmodSync(path, 493);
  return path;
}
function runPowerShell(psPath, cfgPath) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath, cfgPath], { windowsHide: true }, (error) => {
      resolve(error === null);
    });
  });
}
async function createShortcut(desktopDir, managedDir, spec) {
  const launcher = writeLauncherScript(managedDir, spec);
  try {
    if (process2.platform === "win32") {
      const path2 = join2(desktopDir, `${spec.name}.lnk`);
      const cfgPath = join2(managedDir, "shortcut-cfg.json");
      const psPath = join2(managedDir, "create-shortcut.ps1");
      writeFileSync(cfgPath, JSON.stringify({
        path: path2,
        target: launcher,
        arguments: "",
        cwd: managedDir,
        description: spec.description,
        icon: spec.iconPath
      }), "utf8");
      writeFileSync(psPath, [
        "$cfg = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json",
        "$ws = New-Object -ComObject WScript.Shell",
        "$s = $ws.CreateShortcut($cfg.path)",
        "$s.TargetPath = $cfg.target",
        "$s.Arguments = $cfg.arguments",
        "$s.WorkingDirectory = $cfg.cwd",
        "$s.Description = $cfg.description",
        'if ($cfg.icon -ne "") { $s.IconLocation = $cfg.icon }',
        "$s.Save()",
        ""
      ].join("\n"), "utf8");
      const ok = await runPowerShell(psPath, cfgPath);
      return ok ? { path: path2 } : null;
    }
    if (process2.platform === "darwin") {
      const path2 = join2(desktopDir, `${spec.name}.command`);
      const script = readFileSync2(launcher, "utf8");
      writeFileSync(path2, script, "utf8");
      chmodSync(path2, 493);
      return { path: path2 };
    }
    const path = join2(desktopDir, `${spec.name}.desktop`);
    const iconLine = spec.iconPath === "" ? "" : `Icon=${spec.iconPath}`;
    writeFileSync(path, [
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.0",
      `Name=${spec.name}`,
      `Comment=${spec.description}`,
      `Exec=${launcher}`,
      iconLine,
      "Terminal=false",
      "Categories=Network;",
      ""
    ].filter((line) => line !== "").join("\n"), "utf8");
    chmodSync(path, 493);
    return { path };
  } catch {
    return null;
  }
}
async function updateShortcutIcon(handle, iconFile) {
  try {
    if (process2.platform === "win32") {
      const managedDir = join2(handle.path, "..");
      const cfgPath = join2(managedDir, "icon-cfg.json");
      const psPath = join2(managedDir, "update-icon.ps1");
      writeFileSync(cfgPath, JSON.stringify({ path: handle.path, icon: iconFile }), "utf8");
      writeFileSync(psPath, [
        "$cfg = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json",
        "$ws = New-Object -ComObject WScript.Shell",
        "$s = $ws.CreateShortcut($cfg.path)",
        "$s.IconLocation = $cfg.icon",
        "$s.Save()",
        ""
      ].join("\n"), "utf8");
      return await runPowerShell(psPath, cfgPath);
    }
    if (process2.platform === "linux" && handle.path.endsWith(".desktop")) {
      const content = readFileSync2(handle.path, "utf8");
      const lines = content.split("\n").map((line) => /^Icon=/.test(line) ? `Icon=${iconFile}` : line);
      writeFileSync(handle.path, lines.join("\n"), "utf8");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// src/shortcut.ts
function defaultShortcutDeps() {
  return {
    detectDesktopDir,
    createShortcut,
    updateShortcutIcon
  };
}
function managedDirFor() {
  const home = process3.env.DSH_HOME ?? join3(homedir2(), ".dsh");
  return join3(home, "plugins", "dsh-webui-launcher");
}
var ShortcutManager = class {
  constructor(options, deps) {
    this.options = options;
    this.deps = deps;
    this.markerPath = join3(options.managedDir, "shortcut.json");
  }
  markerPath;
  log(message) {
    console.log(`[dsh-webui-launcher] ${message}`);
  }
  /**
   * Create the desktop shortcut once. Never throws: headless hosts, disabled
   * config and creation failures all degrade to a log line.
   */
  async ensure() {
    try {
      if (!this.options.desktopShortcut) {
        this.log("desktop shortcut disabled by config; skipping");
        return;
      }
      if (existsSync3(this.markerPath)) {
        return;
      }
      const desktopDir = this.deps.detectDesktopDir();
      if (desktopDir === null) {
        this.log("no interactive desktop detected; skipping shortcut creation (headless host)");
        return;
      }
      const spec = {
        ...this.options.spec,
        name: this.options.shortcutName,
        iconPath: this.options.shortcutIconPath
      };
      const handle = await this.deps.createShortcut(desktopDir, this.options.managedDir, spec);
      if (handle === null) {
        this.log("desktop shortcut creation failed or was skipped");
        return;
      }
      mkdirSync2(this.options.managedDir, { recursive: true });
      const marker = { createdAt: Date.now(), path: handle.path };
      writeFileSync2(this.markerPath, JSON.stringify(marker), "utf8");
      this.log(`desktop shortcut created at ${handle.path}`);
    } catch (error) {
      this.log(`desktop shortcut creation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Apply a converted icon file to the existing shortcut. When no shortcut
   * exists (headless host, disabled, or creation failed) the icon is simply
   * reported as not applied — the caller may still persist it for a future
   * creation.
   */
  async applyIcon(iconFile) {
    try {
      if (!existsSync3(this.markerPath)) {
        return { ok: false, message: "no desktop shortcut has been created (headless host, disabled, or creation failed)" };
      }
      const marker = JSON.parse(readFileSync3(this.markerPath, "utf8"));
      const ok = await this.deps.updateShortcutIcon({ path: marker.path }, iconFile);
      return ok ? { ok: true, message: `shortcut icon updated: ${iconFile}` } : { ok: false, message: "shortcut icon update is not supported on this platform or failed" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  /** Whether a shortcut was previously created (marker present). */
  hasShortcut() {
    return existsSync3(this.markerPath);
  }
};

// src/browser.ts
import { spawn } from "node:child_process";
import process4 from "node:process";
function openBrowser(url) {
  const platform = process4.platform;
  let command;
  let args;
  if (platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

// src/process.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { join as join4 } from "node:path";
import process5 from "node:process";
var LineLog = class {
  constructor(max) {
    this.max = max;
  }
  lines = [];
  push(chunk) {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed === "") continue;
      this.lines.push(trimmed);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  tail() {
    return [...this.lines];
  }
};
function spawnServer(options) {
  const child = spawn2(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process5.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const log = new LineLog(options.maxLogLines ?? 25);
  child.stdout?.on("data", (chunk) => log.push(chunk));
  child.stderr?.on("data", (chunk) => log.push(chunk));
  return {
    get pid() {
      return child.pid ?? 0;
    },
    exitCode: () => child.exitCode,
    kill: () => killTree(child, log),
    logs: () => log.tail()
  };
}
async function killTree(child, log) {
  if (child.exitCode !== null) return true;
  const pid = child.pid;
  if (pid === void 0) return false;
  if (process5.platform === "win32") {
    if (!await looksLikeNode(pid)) {
      log.push(Buffer.from(`refusing to kill pid ${pid}: tasklist does not show node.exe (possible PID reuse)`, "utf8"));
      return false;
    }
    await runTaskkill(pid);
  } else {
    try {
      process5.kill(-pid, "SIGTERM");
    } catch {
      try {
        process5.kill(pid, "SIGTERM");
      } catch {
      }
    }
  }
  for (let i = 0; i < 15; i += 1) {
    if (child.exitCode !== null) return true;
    await delay(200);
  }
  if (process5.platform !== "win32") {
    try {
      process5.kill(pid, "SIGKILL");
    } catch {
    }
    await delay(300);
  }
  return child.exitCode !== null;
}
function looksLikeNode(pid) {
  const tasklist = join4(process5.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  return new Promise((resolve) => {
    execFile2(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      const match = /^"([^"]+)"/.exec(stdout.trim());
      resolve(match !== null && match[1].toLowerCase() === "node.exe");
    });
  });
}
function runTaskkill(pid) {
  const taskkill = join4(process5.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    execFile2(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/probe.ts
import net from "node:net";
function probeListening(host, port, timeoutMs = 1e3) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
async function probeHttpReady(url, timeoutMs = 3e3) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 200;
  } catch {
    return false;
  }
}

// src/webui.ts
function defaultDeps(options) {
  return {
    probeListening: (host, port) => probeListening(host, port),
    probeHttpReady: (url) => probeHttpReady(url),
    resolveCli: () => resolveCli(options.cliBin),
    spawnServer: (cli, host, port) => spawnServer({
      command: cli.command,
      args: [...cli.prefixArgs, cli.entry, "--profile", "web", "--host", host, "--port", String(port)],
      cwd: cli.cwd,
      maxLogLines: options.maxLogLines
    }),
    openBrowser: (url) => openBrowser(url),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  };
}
var PROBE_BACKOFF_MS = [250, 500, 750, 1e3];
var WebUiRuntime = class {
  constructor(options, deps) {
    this.options = options;
    this.deps = deps;
    this.url = `http://${options.host}:${options.port}`;
  }
  state = "idle";
  server = null;
  lock = Promise.resolve();
  url;
  /** Run one mutation exclusively; concurrent calls queue behind it. */
  serialized(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  /** A status snapshot without side effects (port probes are the only I/O). */
  async status() {
    const listening = await this.deps.probeListening(this.options.host, this.options.port);
    const ready = listening ? await this.deps.probeHttpReady(this.url) : false;
    const spawned = this.server !== null && this.server.exitCode() === null;
    return {
      port: this.options.port,
      host: this.options.host,
      url: this.url,
      state: this.state,
      listening,
      ready,
      spawned,
      adopted: listening && this.server === null,
      pid: spawned ? this.server.pid : null,
      exitCode: this.server?.exitCode() ?? null,
      logs: this.server?.logs() ?? []
    };
  }
  /**
   * Start the Web UI: adopt an already-listening server, otherwise spawn
   * `dsh --profile web` and wait for HTTP 200. Serialized: a second `start`
   * while one is in flight queues behind it and reports the same outcome.
   */
  async start(signal) {
    return this.serialized(async () => {
      if (this.state === "starting") {
        throw new Error("webui.start: another start is already in progress");
      }
      if (this.state === "running" && this.server !== null) {
        const status2 = await this.status();
        return { status: status2, message: `Web UI ready at ${this.url} (pid ${status2.pid})` };
      }
      if (await this.deps.probeListening(this.options.host, this.options.port)) {
        this.state = "running";
        const status2 = await this.status();
        return { status: status2, message: `adopted the Web UI already serving ${this.url}` };
      }
      const cli = this.deps.resolveCli();
      const server = this.deps.spawnServer(cli, this.options.host, this.options.port);
      this.server = server;
      this.state = "starting";
      const startedAt = this.deps.now();
      let attempt = 0;
      try {
        for (; ; ) {
          if (signal.aborted) {
            await this.stopSpawned();
            throw new Error("webui.start aborted");
          }
          const exited = server.exitCode();
          if (exited !== null) {
            if (await this.deps.probeListening(this.options.host, this.options.port)) {
              this.server = null;
              this.state = "running";
              const status2 = await this.status();
              return {
                status: status2,
                message: `our dsh exited (code ${exited}); adopted the server now on ${this.url}`
              };
            }
            this.server = null;
            this.state = "idle";
            throw new Error(
              `dsh exited before serving ${this.url} (code ${exited}). Log tail:
${server.logs().join("\n") || "(no output)"}`
            );
          }
          if (await this.deps.probeListening(this.options.host, this.options.port)) {
            if (await this.deps.probeHttpReady(this.url)) break;
          }
          if (this.deps.now() - startedAt > this.options.startupTimeoutMs) {
            await this.stopSpawned();
            throw new Error(
              `Web UI did not become ready within ${Math.round(this.options.startupTimeoutMs / 1e3)}s. Log tail:
${server.logs().join("\n") || "(no output)"}`
            );
          }
          await this.deps.sleep(PROBE_BACKOFF_MS[attempt] ?? 1e3);
          attempt += 1;
        }
      } catch (error) {
        this.state = "idle";
        throw error;
      }
      this.state = "running";
      const status = await this.status();
      const message = `Web UI ready at ${this.url} (pid ${status.pid})`;
      if (this.options.openBrowserOnStart) {
        await this.deps.openBrowser(this.url);
      }
      return { status, message };
    });
  }
  /**
   * Stop the server this runtime spawned. An adopted server is never stopped.
   */
  async stop() {
    return this.serialized(async () => {
      if (this.server === null) {
        const status2 = await this.status();
        return { status: status2, message: "nothing to stop: this plugin spawned no server" };
      }
      if (this.server.exitCode() !== null) {
        const pid2 = this.server.pid;
        const code = this.server.exitCode();
        this.server = null;
        this.state = "idle";
        const status2 = await this.status();
        return { status: status2, message: `server pid ${pid2} already exited (code ${code})` };
      }
      const pid = this.server.pid;
      this.state = "stopping";
      const stopped = await this.stopSpawned();
      const status = await this.status();
      return stopped ? { status, message: `stopped the Web UI server (pid ${pid})` } : { status, message: `server pid ${pid} still running after kill attempts` };
    });
  }
  /** Open the default browser on the Web UI URL (no start/stop side effects). */
  async open() {
    const status = await this.status();
    if (!status.listening) {
      return { status, message: `nothing serving ${this.url} \u2014 run webui.start first` };
    }
    const opened = await this.deps.openBrowser(this.url);
    return opened ? { status, message: `opened the default browser on ${this.url}` } : { status, message: `failed to open the default browser on ${this.url}` };
  }
  /** Plugin-unload cleanup: stop the spawned server, if any (orphan guard). */
  async dispose() {
    await this.serialized(async () => {
      if (this.server !== null && this.server.exitCode() === null) {
        await this.stopSpawned();
      } else {
        this.server = null;
        this.state = "idle";
      }
    });
  }
  /** Clear the server reference and stop it; resolves whether it is gone. */
  async stopSpawned() {
    const server = this.server;
    this.server = null;
    this.state = "idle";
    if (server === null) return true;
    return server.kill();
  }
};

// src/index.ts
var name = "dsh-webui-launcher";
var inject = ["tools", "commands", "webServer"];
var Config = Schema.object({
  port: Schema.number().step(1).min(1).max(65535).default(3080),
  host: Schema.string().default("127.0.0.1"),
  cliBin: Schema.string().default(""),
  startupTimeoutMs: Schema.number().step(1).min(1e3).default(12e4),
  openBrowserOnStart: Schema.boolean().default(true),
  desktopShortcut: Schema.boolean().default(true),
  shortcutName: Schema.string().min(1).default("DeepSeek Harness Web UI"),
  shortcutIconPath: Schema.string().default("")
});
var output = {
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
      status: {
        type: "object",
        properties: {
          port: { type: "number" },
          host: { type: "string" },
          url: { type: "string" },
          state: { type: "string" },
          listening: { type: "boolean" },
          ready: { type: "boolean" },
          spawned: { type: "boolean" },
          adopted: { type: "boolean" },
          pid: { type: "number" },
          exitCode: { type: "number" }
        },
        required: ["port", "host", "url", "state", "listening", "ready", "spawned", "adopted"]
      }
    },
    required: ["ok", "message", "status"]
  },
  render: (_args, value) => [
    { type: "text", text: value.message }
  ]
};
function buildTools(runtime) {
  return [
    defineTool({
      name: "webui.status",
      description: "Report whether the DeepSeek Harness Web UI is listening and ready on host:port.",
      parameters: {},
      output,
      async execute() {
        const status = await runtime.status();
        return {
          ok: status.ready,
          message: status.ready ? `Web UI ready at ${status.url}` : `nothing serving ${status.url} (listening: ${status.listening})`,
          status
        };
      }
    }),
    defineTool({
      name: "webui.start",
      description: "Start the DeepSeek Harness Web UI: adopts a server already listening on the port, otherwise spawns `dsh --profile web` in the background and waits until it answers HTTP 200.",
      parameters: {},
      output,
      async execute(_args, exec) {
        const result = await runtime.start(exec.signal);
        return { ok: true, message: result.message, status: result.status };
      }
    }),
    defineTool({
      name: "webui.stop",
      description: "Stop the Web UI server this plugin spawned. A server this plugin did not start (adopted) is never stopped.",
      parameters: {},
      output,
      async execute() {
        const result = await runtime.stop();
        return { ok: true, message: result.message, status: result.status };
      }
    }),
    defineTool({
      name: "webui.open",
      description: "Open the default browser on the Web UI URL without starting or stopping anything.",
      parameters: {},
      output,
      async execute() {
        const result = await runtime.open();
        return { ok: true, message: result.message, status: result.status };
      }
    })
  ];
}
function buildCommand(runtime) {
  return {
    name: "webui",
    description: "Start, stop, check or open the DeepSeek Harness Web UI.",
    input: { hint: "start | stop | status | open" },
    handler: async ({ rawInput, signal }) => {
      const verb = (rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase();
      try {
        switch (verb) {
          case "start": {
            const result = await runtime.start(signal);
            return { kind: "success", text: result.message };
          }
          case "stop": {
            const result = await runtime.stop();
            return { kind: "success", text: result.message };
          }
          case "status": {
            const status = await runtime.status();
            const state = status.ready ? `ready at ${status.url}` : status.listening ? `listening on ${status.url} but not answering` : `not serving ${status.url}`;
            const owner = status.spawned ? ` (spawned by this plugin, pid ${status.pid})` : status.adopted ? " (adopted)" : "";
            return { kind: "success", text: `Web UI ${state}${owner}` };
          }
          case "open": {
            const result = await runtime.open();
            return { kind: "success", text: result.message };
          }
          case "":
            return { kind: "error", text: "usage: /webui start | stop | status | open" };
          default:
            return { kind: "error", text: `unknown /webui verb "${verb}" \u2014 usage: /webui start | stop | status | open` };
        }
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
function apply(ctx, config) {
  const options = {
    port: config?.port ?? 3080,
    host: config?.host ?? "127.0.0.1",
    cliBin: config?.cliBin ?? "",
    startupTimeoutMs: config?.startupTimeoutMs ?? 12e4,
    openBrowserOnStart: config?.openBrowserOnStart ?? true,
    maxLogLines: 25
  };
  const runtime = new WebUiRuntime(options, defaultDeps(options));
  const managedDir = managedDirFor();
  let shortcut = null;
  try {
    const cli = resolveCli(options.cliBin);
    const spec = {
      command: process6.execPath,
      cliArgs: [...cli.prefixArgs, cli.entry, "--profile", "web", "--host", options.host, "--port", String(options.port)],
      cwd: cli.cwd,
      url: `http://${options.host}:${options.port}`,
      description: "Launch the DeepSeek Harness Web UI"
    };
    shortcut = new ShortcutManager({
      desktopShortcut: config?.desktopShortcut ?? true,
      shortcutName: config?.shortcutName ?? "DeepSeek Harness Web UI",
      shortcutIconPath: config?.shortcutIconPath ?? "",
      managedDir,
      spec
    }, defaultShortcutDeps());
    void shortcut.ensure();
  } catch (error) {
    console.log(`[dsh-webui-launcher] desktop shortcut disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const iconUpload = async (bytes, name2) => {
    try {
      const set = await convertImageToIcon(bytes);
      mkdirSync3(managedDir, { recursive: true });
      const icoPath = join5(managedDir, "icon.ico");
      const pngPath = join5(managedDir, "icon.png");
      writeFileSync3(icoPath, set.ico);
      writeFileSync3(pngPath, set.png);
      const iconFile = process6.platform === "win32" ? icoPath : pngPath;
      const applied = shortcut !== null ? await shortcut.applyIcon(iconFile) : { ok: false, message: "desktop shortcut unavailable" };
      return {
        ok: applied.ok,
        message: `${applied.message} (converted from "${name2 || "image"}" to ${process6.platform === "win32" ? "ICO" : "PNG"})`,
        formats: ["ico", "png"]
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  ctx.effect(() => {
    const disposeRoutes = registerWebUiEndpoints(ctx.webServer, runtime, iconUpload);
    return () => {
      disposeRoutes();
      void runtime.dispose();
    };
  }, "dsh-webui-launcher.lifecycle");
  for (const tool of buildTools(runtime)) {
    ctx.tools.register(tool);
  }
  ctx.commands.register(buildCommand(runtime));
}
export {
  Config,
  ShortcutManager,
  WebUiRuntime,
  apply,
  convertImageToIcon,
  defaultDeps,
  defaultShortcutDeps,
  detectDesktopDir,
  inject,
  managedDirFor,
  name,
  packIco
};
//# sourceMappingURL=index.js.map
