window.__ModuleLoader__.load({
	id: "dsh-webui-launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/WebUISection.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
async function call(verb, body = "{}") {
  try {
    const response = await fetch(`/webui/${verb}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
var styles = {
  row: { display: "flex", alignItems: "center", gap: 8, margin: "8px 0" },
  dot: (color) => ({
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
    flex: "none"
  }),
  button: {
    padding: "4px 14px",
    border: "1px solid rgba(127,127,127,.4)",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 13
  },
  muted: { color: "rgba(127,127,127,.85)", fontSize: 12, margin: "4px 0" },
  message: { fontSize: 12, margin: "6px 0 0" }
};
function WebUISection({ t }) {
  const translate = (key) => t ? t(key) : key;
  const [status, setStatus] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [message, setMessage] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [iconData, setIconData] = (0, import_react.useState)("");
  const [iconPreview, setIconPreview] = (0, import_react.useState)("");
  const [iconName, setIconName] = (0, import_react.useState)("");
  const [iconBusy, setIconBusy] = (0, import_react.useState)(false);
  const [iconResult, setIconResult] = (0, import_react.useState)(null);
  const alive = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => {
    alive.current = true;
    const tick = async () => {
      const result = await call("status");
      if (!alive.current) return;
      if (result.ok && result.status) setStatus(result.status);
    };
    void tick();
    const id = setInterval(() => void tick(), 3e3);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, []);
  const run = async (verb) => {
    setBusy(true);
    setError("");
    setMessage("");
    const result = await call(verb);
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      if (result.status) setStatus(result.status);
      setMessage(result.message ?? "");
    } else if (verb === "stop" || verb === "open") {
      setMessage(verb === "stop" ? translate("stopSent") : translate("openSent"));
    } else {
      setError(result.error ?? translate("unknown"));
    }
    const fresh = await call("status");
    if (alive.current && fresh.ok && fresh.status) setStatus(fresh.status);
  };
  const onIconFile = (file) => {
    if (file === void 0) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const comma = dataUrl.indexOf(",");
      setIconData(comma >= 0 ? dataUrl.slice(comma + 1) : "");
      setIconPreview(dataUrl);
      setIconName(file.name);
      setIconResult(null);
    };
    reader.readAsDataURL(file);
  };
  const applyIcon = async () => {
    if (iconData === "") return;
    setIconBusy(true);
    setIconResult(null);
    const result = await call("icon", JSON.stringify({ data: iconData, name: iconName }));
    if (!alive.current) return;
    setIconBusy(false);
    setIconResult({ ok: result.ok, text: result.message ?? result.error ?? translate("unknown") });
  };
  const stateLabel = status ? status.ready ? translate("ready") : status.listening ? translate("listening") : translate("notServing") : translate("unknown");
  const dotColor = status?.ready ? "#3fb950" : status?.listening ? "#d29922" : "#8b949e";
  const stopDisabled = busy || !(status?.stoppable ?? false);
  const openDisabled = busy || !(status?.listening ?? false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: translate("intro") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.dot(dotColor) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: stateLabel }),
      status?.url ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.muted, children: status.url }) : null
    ] }),
    status?.spawned ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.muted, children: [
      translate("spawned"),
      " (pid ",
      status.pid,
      ")"
    ] }) : null,
    status?.adopted ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: status.stoppable ? translate("adoptedLauncher") : translate("adopted") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, margin: "10px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: stopDisabled, onClick: () => void run("stop"), children: translate("stop") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: openDisabled, onClick: () => void run("open"), children: translate("open") })
    ] }),
    error !== "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.message, color: "#f85149" }, children: [
      translate("error"),
      ": ",
      error
    ] }) : null,
    message !== "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.message, children: message }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("hr", { style: { border: "none", borderTop: "1px solid rgba(127,127,127,.25)", margin: "14px 0" } }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: translate("iconTitle") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.muted, children: translate("iconHint") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10, margin: "8px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "label",
        {
          style: {
            ...styles.button,
            display: "inline-block",
            cursor: "pointer",
            padding: "4px 10px"
          },
          children: [
            translate("chooseIcon"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "file",
                accept: "image/*",
                style: { display: "none" },
                onChange: (event) => onIconFile(event.target.files?.[0])
              }
            )
          ]
        }
      ),
      iconPreview !== "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", { src: iconPreview, alt: iconName, style: { width: 40, height: 40, objectFit: "contain", border: "1px solid rgba(127,127,127,.4)", borderRadius: 6 } }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: iconBusy || iconData === "", onClick: () => void applyIcon(), children: iconBusy ? translate("busy") : translate("applyIcon") })
    ] }),
    iconResult !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: iconResult.ok ? styles.message : { ...styles.message, color: "#f85149" }, children: [
      iconResult.ok ? translate("iconApplied") : translate("iconFailed"),
      ": ",
      iconResult.text
    ] }) : null
  ] });
}

// src/client/locales.ts
var NS = "settings.webui";
var en = {
  nav: "Web UI Launcher",
  title: "Web UI Launcher",
  intro: "Stop or open the DeepSeek Harness Web UI from here.",
  ready: "Ready",
  listening: "Listening",
  notServing: "Not serving",
  url: "URL",
  start: "Start",
  stop: "Stop",
  open: "Open browser",
  busy: "Working\u2026",
  error: "Error",
  stopSent: "Stop requested \u2014 the server is shutting down\u2026",
  openSent: "Opened in the default browser.",
  spawned: "Started by this plugin",
  adopted: "Adopted \u2014 this plugin did not start it and will not stop it",
  adoptedLauncher: "Adopted \u2014 started by the desktop launcher; can be stopped",
  unknown: "Unknown",
  iconTitle: "Shortcut icon",
  iconHint: "PNG, JPEG, BMP, GIF or TIFF \u2014 converted automatically (ICO on Windows, PNG on Linux).",
  chooseIcon: "Choose an image",
  applyIcon: "Apply icon",
  iconApplied: "Shortcut icon updated",
  iconFailed: "Icon update failed",
  noShortcut: "No desktop shortcut exists yet"
};
var zh = {
  nav: "Web UI \u542F\u52A8\u5668",
  title: "Web UI \u542F\u52A8\u5668",
  intro: "\u4ECE\u8FD9\u91CC\u505C\u6B62\u6216\u6253\u5F00 DeepSeek Harness Web UI\u3002",
  ready: "\u5C31\u7EEA",
  listening: "\u6B63\u5728\u76D1\u542C",
  notServing: "\u672A\u5728\u670D\u52A1",
  url: "\u5730\u5740",
  start: "\u542F\u52A8",
  stop: "\u505C\u6B62",
  open: "\u6253\u5F00\u6D4F\u89C8\u5668",
  busy: "\u5904\u7406\u4E2D\u2026",
  error: "\u9519\u8BEF",
  stopSent: "\u5DF2\u8BF7\u6C42\u505C\u6B62\u2014\u2014\u670D\u52A1\u5668\u6B63\u5728\u5173\u95ED\u2026",
  openSent: "\u5DF2\u5728\u9ED8\u8BA4\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00\u3002",
  spawned: "\u7531\u672C\u63D2\u4EF6\u542F\u52A8",
  adopted: "\u5DF2\u63A5\u7BA1\uFF08\u975E\u672C\u63D2\u4EF6\u542F\u52A8\uFF0C\u4E0D\u4F1A\u88AB\u505C\u6B62\uFF09",
  adoptedLauncher: "\u5DF2\u63A5\u7BA1\uFF08\u7531\u684C\u9762\u542F\u52A8\u5668\u542F\u52A8\uFF0C\u53EF\u505C\u6B62\uFF09",
  unknown: "\u672A\u77E5",
  iconTitle: "\u5FEB\u6377\u65B9\u5F0F\u56FE\u6807",
  iconHint: "\u652F\u6301 PNG/JPEG/BMP/GIF/TIFF\uFF0C\u81EA\u52A8\u8F6C\u6362\uFF08Windows \u7528 ICO\uFF0CLinux \u7528 PNG\uFF09\u3002",
  chooseIcon: "\u9009\u62E9\u56FE\u7247",
  applyIcon: "\u5E94\u7528\u56FE\u6807",
  iconApplied: "\u5FEB\u6377\u65B9\u5F0F\u56FE\u6807\u5DF2\u66F4\u65B0",
  iconFailed: "\u56FE\u6807\u66F4\u65B0\u5931\u8D25",
  noShortcut: "\u5C1A\u672A\u521B\u5EFA\u684C\u9762\u5FEB\u6377\u65B9\u5F0F"
};

// src/client/index.ts
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-webui-launcher: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "webui-launcher",
    order: 200,
    label: () => t("nav"),
    inject: () => ({ t })
  }, WebUISection));
}

		return module.exports;
	},
});
//# sourceMappingURL=client.js.map
