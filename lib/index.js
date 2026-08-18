// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";

// src/endpoints.ts
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
function registerWebUiEndpoints(webServer, runtime) {
  const aborters = /* @__PURE__ */ new Set();
  const handlers = {
    status: async () => {
      const status = await runtime.status();
      return { message: status.ready ? `Web UI ready at ${status.url}` : `nothing serving ${status.url}`, status };
    },
    start: async (_args, signal) => {
      const result = await runtime.start(signal);
      return { message: result.message, status: result.status };
    },
    stop: async () => {
      const result = await runtime.stop();
      return { message: result.message, status: result.status };
    },
    open: async () => {
      const result = await runtime.open();
      return { message: result.message, status: result.status };
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
          const result = await handlers[verb]({}, controller.signal);
          sendJson(res, 200, { ok: true, message: result.message, status: result.status });
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

// src/webui.ts
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, basename } from "node:path";
import process from "node:process";
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
var LineLog = class {
  constructor(max) {
    this.max = max;
  }
  lines = [];
  push(chunk) {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
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
function resolveCliScript(cliBin) {
  if (cliBin !== "") return cliBin;
  const argvScript = process.argv[1];
  if (typeof argvScript === "string" && argvScript !== "") {
    const name2 = basename(argvScript);
    if (name2 === "bin.js" || name2 === "bin.ts" || /(^|[\\/])apps[\\/]cli[\\/]/.test(argvScript)) {
      return argvScript;
    }
  }
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
function resolveCliWorkingDir(cliScript) {
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
async function openBrowser(url) {
  const platform = process.platform;
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
var WebUiRuntime = class {
  child = null;
  nodeExe = process.execPath;
  options;
  log;
  constructor(options) {
    this.options = options;
    this.log = new LineLog(options.maxLogLines);
  }
  /** A status snapshot without side effects (a port probe is the only I/O). */
  async status() {
    const url = `http://${this.options.host}:${this.options.port}`;
    const listening = await probeListening(this.options.host, this.options.port);
    return {
      port: this.options.port,
      host: this.options.host,
      url,
      listening,
      ready: listening ? await probeHttpReady(url) : false,
      spawned: this.child !== null && this.child.exitCode === null,
      adopted: listening && (this.child === null || this.child.exitCode !== null),
      pid: this.child !== null && this.child.exitCode === null ? this.child.pid ?? null : null,
      exitCode: this.child?.exitCode ?? null,
      logs: this.log.tail()
    };
  }
  /**
   * Start the Web UI: adopt an already-listening server, otherwise spawn
   * `dsh --profile web` and wait for HTTP 200. Aborts (rejects) on
   * `signal.abort` and on startup timeout or server exit.
   */
  async start(signal) {
    if (await probeListening(this.options.host, this.options.port)) {
      const status2 = await this.status();
      return { status: status2, message: `adopted the Web UI already serving ${status2.url}` };
    }
    if (this.child !== null && this.child.exitCode === null) {
      throw new Error(`a server spawned by this plugin (pid ${this.child.pid}) is still starting`);
    }
    const cliScript = resolveCliScript(this.options.cliBin);
    const cwd = resolveCliWorkingDir(cliScript);
    const args = [];
    if (cliScript.endsWith(".ts")) args.push("--import", "tsx/esm");
    args.push(cliScript, "--profile", "web", "--host", this.options.host, "--port", String(this.options.port));
    const child = spawn(this.nodeExe, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.log.push(chunk));
    child.stderr?.on("data", (chunk) => this.log.push(chunk));
    const url = `http://${this.options.host}:${this.options.port}`;
    const startedAt = Date.now();
    while (true) {
      if (signal.aborted) {
        this.stopQuietly(child);
        throw new Error("webui.start aborted");
      }
      if (child.exitCode !== null) {
        if (await probeListening(this.options.host, this.options.port)) {
          const status2 = await this.status();
          return { status: status2, message: `our dsh exited (code ${child.exitCode}); adopted the server now on ${url}` };
        }
        throw new Error(
          `dsh exited before serving ${url} (code ${child.exitCode}). Log tail:
${this.log.tail().join("\n") || "(no output)"}`
        );
      }
      if (await probeListening(this.options.host, this.options.port)) {
        if (await probeHttpReady(url)) break;
      }
      if (Date.now() - startedAt > this.options.startupTimeoutMs) {
        this.stopQuietly(child);
        throw new Error(
          `Web UI did not become ready within ${Math.round(this.options.startupTimeoutMs / 1e3)}s. Log tail:
${this.log.tail().join("\n") || "(no output)"}`
        );
      }
      await delay(500);
    }
    const status = await this.status();
    const message = `Web UI ready at ${url} (pid ${status.pid})`;
    if (this.options.openBrowserOnStart) {
      await openBrowser(url);
    }
    return { status, message };
  }
  /**
   * Stop the server this plugin spawned. An adopted server is never stopped.
   * The PID guard is the live ChildProcess handle: once `exitCode` is set the
   * PID may have been recycled, and a recycled PID is never killed.
   */
  async stop() {
    const child = this.child;
    if (child === null) {
      const status2 = await this.status();
      return { status: status2, message: "nothing to stop: this plugin spawned no server" };
    }
    if (child.exitCode !== null) {
      const status2 = await this.status();
      return { status: status2, message: `server pid ${child.pid} already exited (code ${child.exitCode})` };
    }
    const pid = child.pid;
    if (pid === void 0) {
      const status2 = await this.status();
      return { status: status2, message: "server process has no pid; nothing killed" };
    }
    const stopped = await this.killTree(child, pid);
    const status = await this.status();
    return stopped ? { status, message: `stopped the Web UI server (pid ${pid})` } : { status, message: `server pid ${pid} still running after kill attempts` };
  }
  /** Open the default browser on the Web UI URL (no start/stop side effects). */
  async open() {
    const status = await this.status();
    if (!status.listening) {
      return { status, message: `nothing serving ${status.url} \u2014 run webui.start first` };
    }
    const opened = await openBrowser(status.url);
    return opened ? { status, message: `opened the default browser on ${status.url}` } : { status, message: `failed to open the default browser on ${status.url}` };
  }
  /** Kill the spawned process tree; Windows uses taskkill /T, POSIX the group. */
  killTree(child, pid) {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        execFile(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true },
          () => this.waitGone(child, resolve)
        );
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
          }
        }
        this.waitGone(child, resolve);
      }
    });
  }
  waitGone(child, resolve, attempts = 0) {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    if (attempts >= 10) {
      if (process.platform !== "win32") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
        }
      }
      resolve(false);
      return;
    }
    setTimeout(() => this.waitGone(child, resolve, attempts + 1), 200);
  }
  /** Fire-and-forget stop used on the abort/timeout paths. */
  stopQuietly(child) {
    if (child.exitCode === null && child.pid !== void 0) {
      void this.killTree(child, child.pid);
    }
  }
};
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/index.ts
var name = "dsh-webui-launcher";
var inject = ["tools", "commands", "webServer"];
var Config = Schema.object({
  port: Schema.number().step(1).min(1).max(65535).default(3080),
  host: Schema.string().default("127.0.0.1"),
  cliBin: Schema.string().default(""),
  startupTimeoutMs: Schema.number().step(1).min(1e3).default(12e4),
  openBrowserOnStart: Schema.boolean().default(true)
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
          listening: { type: "boolean" },
          ready: { type: "boolean" },
          spawned: { type: "boolean" },
          adopted: { type: "boolean" },
          pid: { type: "number" },
          exitCode: { type: "number" }
        },
        required: ["port", "host", "url", "listening", "ready", "spawned", "adopted"]
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
  const runtime = new WebUiRuntime(options);
  const disposeRoutes = registerWebUiEndpoints(ctx.webServer, runtime);
  ctx.effect(() => disposeRoutes, "dsh-webui-launcher.routes");
  for (const tool of buildTools(runtime)) {
    ctx.tools.register(tool);
  }
  ctx.commands.register(buildCommand(runtime));
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
