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
    start: async (signal) => runtime.start(signal),
    stop: async () => runtime.stop(),
    open: async () => runtime.open()
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
          const result = await handlers[verb](controller.signal);
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

// src/browser.ts
import { spawn } from "node:child_process";
import process from "node:process";
function openBrowser(url) {
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

// src/cli.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import process2 from "node:process";
function looksLikeCliScript(p) {
  const name2 = basename(p);
  return name2 === "bin.js" || name2 === "bin.ts" || /(^|[\\/])apps[\\/]cli[\\/]/.test(p) || /(^|[\\/])lib[\\/]bin\.(js|ts)$/.test(p);
}
function resolveCliScript(cliBin, argvScript) {
  if (cliBin !== "") return cliBin;
  const argv = argvScript ?? process2.argv[1];
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
    return { command: process2.execPath, prefixArgs: ["--import", "tsx/esm"], entry: script, cwd: resolveWorkingDir(script) };
  }
  if (/\.(js|cjs|mjs)$/.test(script)) {
    return { command: process2.execPath, prefixArgs: [], entry: script, cwd: resolveWorkingDir(script) };
  }
  return { command: script, prefixArgs: [], entry: script, cwd: dirname(script) };
}

// src/process.ts
import { execFile, spawn as spawn2 } from "node:child_process";
import { join as join2 } from "node:path";
import process3 from "node:process";
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
    env: options.env ?? process3.env,
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
  if (process3.platform === "win32") {
    if (!await looksLikeNode(pid)) {
      log.push(Buffer.from(`refusing to kill pid ${pid}: tasklist does not show node.exe (possible PID reuse)`, "utf8"));
      return false;
    }
    await runTaskkill(pid);
  } else {
    try {
      process3.kill(-pid, "SIGTERM");
    } catch {
      try {
        process3.kill(pid, "SIGTERM");
      } catch {
      }
    }
  }
  for (let i = 0; i < 15; i += 1) {
    if (child.exitCode !== null) return true;
    await delay(200);
  }
  if (process3.platform !== "win32") {
    try {
      process3.kill(pid, "SIGKILL");
    } catch {
    }
    await delay(300);
  }
  return child.exitCode !== null;
}
function looksLikeNode(pid) {
  const tasklist = join2(process3.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  return new Promise((resolve) => {
    execFile(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
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
  const taskkill = join2(process3.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
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
  ctx.effect(() => {
    const disposeRoutes = registerWebUiEndpoints(ctx.webServer, runtime);
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
  WebUiRuntime,
  apply,
  defaultDeps,
  inject,
  name
};
//# sourceMappingURL=index.js.map
