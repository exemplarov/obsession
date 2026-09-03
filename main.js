const { Plugin, ItemView, MarkdownRenderChild, MarkdownRenderer, Notice, PluginSettingTab, Setting, setIcon } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

const VIEW_TYPE_SESSIONS = "opencode-sessions-view";
const VIEW_TYPE_SESSION = "opencode-session-view";
const VIEW_TYPE_NEW_SESSION = "opencode-new-session-view";
const BLOCK_LANGUAGE = "opencode-sessions";
const DEFAULT_REFRESH_SECONDS = 30;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE = 100;
// A session counts as "running" only if its last assistant message started
// streaming recently; older uncompleted messages are sessions killed mid-reply.
// Only used when the v2 API event stream is unavailable (SQLite fallback).
const RUNNING_STALE_MS = 15 * 60 * 1000;
const ENDPOINT_CACHE_MS = 30 * 1000;

const STATE_LABELS = {
  running: "Running…",
  suspended: "Suspended",
  idle: "Idle",
  waiting: "Needs approval",
  interrupted: "Interrupted",
  error: "Error",
  "": "",
};

function defaultDatabasePath() {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

function defaultSqlitePath() {
  return process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
}

function xdgPath(envVar, fallback) {
  const base = process.env[envVar];
  return base ? path.join(base, "opencode") : path.join(os.homedir(), fallback, "opencode");
}

// The v2 server registers itself here when it starts (url + password).
function serviceRegistrationFile() {
  return path.join(xdgPath("XDG_STATE_HOME", ".local/state"), "service.json");
}

// CLI-owned service config; persists the password for managed servers.
function serviceConfigFile() {
  return path.join(xdgPath("XDG_CONFIG_HOME", ".config"), "service.json");
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateSqlWhereFragment(value) {
  const fragment = String(value || "").trim();
  if (fragment.includes(";") || fragment.includes("--") || fragment.includes("/*") || fragment.includes("*/")) {
    throw new Error("Custom SQL must be a single WHERE fragment without comments or semicolons.");
  }
  return fragment;
}

function runSqlite(sqlitePath, databasePath, sql) {
  return new Promise((resolve, reject) => {
    execFile(
      sqlitePath || "sqlite3",
      ["-readonly", "-json", databasePath, sql],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : []);
        } catch (parseError) {
          reject(new Error(`Could not parse sqlite3 output: ${parseError.message}`));
        }
      },
    );
  });
}

function modelLabel(value) {
  if (!value) return "";
  try {
    const model = typeof value === "string" ? JSON.parse(value) : value;
    return [model.providerID || model.providerId, model.id || model.modelID]
      .filter(Boolean)
      .join("/");
  } catch {
    return String(value);
  }
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  return new Date(Number(timestamp)).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(Number(timestamp));
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function formatTokens(tokens) {
  const numbers = [];
  if (tokens && typeof tokens === "object") {
    const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
    numbers.push(tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write);
  } else {
    numbers.push(tokens);
  }
  const total = numbers.map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  return total ? total.toLocaleString() : "";
}

function formatTokensFromRow(row) {
  const total = [row.tokens_input, row.tokens_output, row.tokens_reasoning]
    .map(Number)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  return total ? total.toLocaleString() : "";
}

function displayDirectory(directory, vaultRoot) {
  if (!directory) return "";
  if (directory === vaultRoot) return ".";
  return directory.startsWith(`${vaultRoot}${path.sep}`)
    ? path.relative(vaultRoot, directory)
    : directory;
}

// Parses ```opencode-sessions block config: a JSON object, or simple
// "key: value" lines with optional "- item" lists (e.g. dirs).
function parseBlockConfig(source) {
  const text = String(source || "").trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid JSON config: ${error.message}`);
    }
  }
  const config = {};
  let currentList = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      if (currentList) currentList.push(line.slice(2).trim());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === "") {
      currentList = [];
      config[key] = currentList;
    } else {
      currentList = null;
      config[key] = value;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// HTTP transport. Node's http/https modules instead of fetch: the v2 server
// does not send CORS headers, and the Obsidian renderer enforces CORS on
// fetch/EventSource — so browser-network APIs cannot reach localhost:port.
// Node sockets bypass CORS entirely (plugin is desktop-only anyway).
// ---------------------------------------------------------------------------

function nodeRequest(url, options = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 15000 } = options;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders["content-length"] = String(Buffer.byteLength(body));
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${method} ${url}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Minimal SSE client over a Node socket: parses `data:` frames, ignores
// comments (the server's `: heartbeat` keepalives), and fails if the stream
// goes silent past idleTimeoutMs so the caller can reconnect.
class NodeSSE {
  constructor(url, options = {}) {
    const { headers = {}, idleTimeoutMs = 45000 } = options;
    this.url = url;
    this.headers = headers;
    this.idleTimeoutMs = idleTimeoutMs;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.readyState = 0;
    this.closed = false;
    this.req = null;
    this.idleTimer = null;
    this.buffer = "";
    this._start();
  }

  _start() {
    let parsed;
    try {
      parsed = new URL(this.url);
    } catch (error) {
      this._fail(error);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { ...this.headers, accept: "text/event-stream", "cache-control": "no-cache" },
      },
      (res) => {
        if (this.closed) {
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          this._fail(new Error(`SSE ${res.statusCode} for ${this.url}`));
          return;
        }
        this.readyState = 1;
        this._touchIdle();
        if (this.onopen) this.onopen({});
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (this.closed) return;
          this._touchIdle();
          this.buffer += chunk;
          let index;
          while ((index = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, index).replace(/\r$/, "");
            this.buffer = this.buffer.slice(index + 1);
            if (line.startsWith("data:")) {
              let payload = line.slice(5);
              if (payload.startsWith(" ")) payload = payload.slice(1);
              if (this.onmessage) this.onmessage({ data: payload });
            }
          }
        });
        res.on("end", () => this._fail(new Error("event stream ended")));
        res.on("error", (error) => this._fail(error));
      },
    );
    req.on("error", (error) => this._fail(error));
    this.req = req;
    req.end();
  }

  _touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this._fail(new Error(`no data for ${this.idleTimeoutMs}ms (heartbeat lost)`));
    }, this.idleTimeoutMs);
  }

  _fail(error) {
    if (this.closed) return;
    this.close();
    if (this.onerror) this.onerror(error);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.req) {
      this.req.destroy();
      this.req = null;
    }
  }
}

// ---------------------------------------------------------------------------
// OpenCode v2 (beta) API client. Discovers the local server from
// ~/.local/state/opencode/service.json, then talks to /api/* with Basic auth.
// ---------------------------------------------------------------------------

class OpenCodeClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.endpoint = null;
    this.endpointAt = 0;
    this.healthInfo = null;
  }

  invalidate() {
    this.endpoint = null;
    this.endpointAt = 0;
  }

  static async probe(baseUrl, password, timeoutMs = 2500) {
    try {
      const headers = { accept: "application/json" };
      if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const res = await nodeRequest(`${baseUrl.replace(/\/+$/, "")}/api/health`, { headers, timeoutMs });
      if (res.status !== 200) return null;
      const body = JSON.parse(res.body || "null");
      return body && body.healthy ? body : null;
    } catch {
      return null;
    }
  }

  async resolve(force = false) {
    if (!force && this.endpoint && Date.now() - this.endpointAt < ENDPOINT_CACHE_MS) {
      return this.endpoint;
    }
    const settings = this.plugin.settings;
    const overrideUrl = String(settings.apiBaseUrl || "").trim().replace(/\/+$/, "");
    const overridePassword = String(settings.apiPassword || "").trim();
    const candidates = [];
    if (overrideUrl) candidates.push({ baseUrl: overrideUrl, password: overridePassword });
    const registration = readJsonFile(serviceRegistrationFile());
    if (registration && registration.url) {
      candidates.push({
        baseUrl: String(registration.url).replace(/\/+$/, ""),
        password: overridePassword || String(registration.password || ""),
      });
    }
    const config = readJsonFile(serviceConfigFile());
    const fallbackPassword = overridePassword || String((config && config.password) || "");
    candidates.push({ baseUrl: "http://127.0.0.1:49374", password: fallbackPassword });
    candidates.push({ baseUrl: "http://127.0.0.1:4096", password: fallbackPassword });
    for (const candidate of candidates) {
      const health = await OpenCodeClient.probe(candidate.baseUrl, candidate.password);
      if (health) {
        this.endpoint = candidate;
        this.endpointAt = Date.now();
        this.healthInfo = health;
        return candidate;
      }
    }
    throw new Error("OpenCode v2 server not found (no /api/health responded)");
  }

  async request(pathname, options = {}) {
    const { method = "GET", body, timeoutMs = 15000 } = options;
    const endpoint = await this.resolve();
    const headers = { accept: "application/json" };
    if (endpoint.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await nodeRequest(`${endpoint.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      this.invalidate();
      throw error;
    }
    if (res.status === 401) this.invalidate();
    if (res.status < 200 || res.status >= 300) {
      const detail = res.body ? ` — ${res.body.slice(0, 200)}` : "";
      throw new Error(`${res.status}${detail}`);
    }
    if (res.status === 204) return null;
    const contentType = String(res.headers["content-type"] || "");
    return contentType.includes("json") ? JSON.parse(res.body || "null") : res.body;
  }

  health() {
    return this.request("/api/health", { timeoutMs: 4000 });
  }

  session(sessionId) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}`);
  }

  messages(sessionId, options = {}) {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.order) query.set("order", options.order);
    if (options.cursor) query.set("cursor", options.cursor);
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`);
  }

  activeSessions() {
    return this.request("/api/session/active");
  }

  // Object-typed query params use bracket encoding: location[directory]=…
  locationQuery(directory) {
    return directory
      ? `?${encodeURIComponent("location[directory]")}=${encodeURIComponent(directory)}`
      : "";
  }

  models(directory) {
    return this.request(`/api/model${this.locationQuery(directory)}`);
  }

  defaultModel(directory) {
    return this.request(`/api/model/default${this.locationQuery(directory)}`);
  }

  setSessionModel(sessionId, model) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: { model },
    });
  }

  sessionPermissions(sessionId) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/permission`);
  }

  replyPermission(sessionId, requestId, reply) {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: { reply } },
    );
  }

  prompt(sessionId, text) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { text },
    });
  }

  interrupt(sessionId) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
    });
  }
}

// ---------------------------------------------------------------------------
// Live event stream (SSE) from GET /api/event. One shared connection for the
// whole plugin; drives live session state (running/idle/…) and streaming
// updates in open session views.
// ---------------------------------------------------------------------------

class ServerEventStream {
  constructor(plugin) {
    this.plugin = plugin;
    this.source = null;
    this.connected = false;
    this.started = false;
    this.reconnectTimer = null;
    this.connecting = null;
    this.attempt = 0;
    this.everConnected = false;
    this.lifecycleAttached = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.startLifecycleWatch();
    this.connect();
  }

  stop() {
    this.started = false;
    this.stopLifecycleWatch();
    this.closeSource();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setConnected(false);
  }

  // Page inactive / sleep / network drop can silently kill SSE without an
  // explicit error (throttled timers, dead sockets, missed heartbeats).
  // Re-probe as soon as the page is visible again or the browser is online.
  startLifecycleWatch() {
    if (this.lifecycleAttached) return;
    this.lifecycleAttached = true;
    this.onVisibility = () => {
      if (!this.started || document.visibilityState !== "visible") return;
      if (!this.source || !this.connected) this.reconnectSoon(1);
      else if (typeof this.plugin.refreshStaleSessions === "function") {
        this.plugin.refreshStaleSessions("visible");
      }
    };
    this.onOnline = () => {
      if (this.started) this.reconnectSoon(1);
    };
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
  }

  stopLifecycleWatch() {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    if (this.onVisibility) document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.onOnline) window.removeEventListener("online", this.onOnline);
    this.onVisibility = null;
    this.onOnline = null;
  }

  reconnectSoon(delayMs) {
    if (!this.started || this.reconnectTimer) return;
    // Drop the current connection (if any) so the scheduled connect() can
    // proceed — it refuses to run while a source is still attached.
    this.closeSource();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  closeSource() {
    if (!this.source) return;
    this.source.onopen = null;
    this.source.onmessage = null;
    this.source.onerror = null;
    this.source.close();
    this.source = null;
  }

  async connect() {
    if (!this.started || this.source || this.connecting) return;
    let endpoint;
    try {
      endpoint = await (this.connecting = this.plugin.client.resolve(this.attempt > 0));
    } catch {
      endpoint = null;
    } finally {
      this.connecting = null;
    }
    if (!endpoint) {
      this.setConnected(false);
      this.reconnectSoon(Math.min(30000, 2000 * Math.max(1, ++this.attempt)));
      return;
    }
    if (!this.started) return;
    const headers = {};
    if (endpoint.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`;
    }
    const source = new NodeSSE(`${endpoint.baseUrl}/api/event`, { headers });
    this.source = source;
    source.onopen = () => {
      this.attempt = 0;
      // setConnected(true) drives syncActiveSessions + open-session
      // reconcile via onStreamReconnected (covers first connect too,
      // when views may have loaded from the offline SQLite fallback).
      this.setConnected(true);
    };
    source.onmessage = (message) => {
      let event = null;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event && event.type) this.plugin.handleServerEvent(event);
    };
    source.onerror = () => {
      // NodeSSE closes itself before reporting; re-discover and retry with
      // backoff (idle watchdog, stream end, socket error, bad status).
      if (source !== this.source) return;
      this.closeSource();
      this.setConnected(false);
      this.plugin.client.invalidate();
      this.reconnectSoon(Math.min(30000, 1000 * 2 ** Math.min(5, ++this.attempt)));
    };
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.plugin.emitChange();
    // Lost-then-recovered stream: views missed SSE deltas while offline,
    // so force a full reconcile of every open session on every reconnect
    // (first connect included — views may have rendered the DB fallback).
    if (value) {
      this.everConnected = true;
      if (typeof this.plugin.onStreamReconnected === "function") {
        this.plugin.onStreamReconnected();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard (session list) — same renderer for the dedicated view and for
// ```opencode-sessions blocks embedded in notes.
// ---------------------------------------------------------------------------

class SessionsDashboard {
  constructor(plugin, container, options = {}) {
    this.plugin = plugin;
    this.container = container;
    this.options = options;
    this.sessions = [];
    this.filterNeedle = "";
    this.visible = DEFAULT_PAGE_SIZE;
    this.disposed = false;
  }

  basePageSize() {
    const block = Number(this.options.pageSize);
    if (Number.isFinite(block) && block > 0) return block;
    const setting = Number(this.plugin.settings?.pageSize);
    if (Number.isFinite(setting) && setting > 0) return setting;
    return DEFAULT_PAGE_SIZE;
  }

  layout() {
    return String(this.options.layout || "cards").toLowerCase() === "table" ? "table" : "cards";
  }

  async mount() {
    const { container } = this;
    container.addClass("opencode-sessions-dashboard");

    if (this.options.title) {
      container.createEl("h2", { text: String(this.options.title) });
    }

    const toolbar = container.createDiv({ cls: "opencode-sessions-cards-toolbar" });
    this.statusEl = toolbar.createSpan({ cls: "opencode-sessions-cards-count", text: "Loading…" });
    this.filterInput = toolbar.createEl("input", {
      type: "search",
      cls: "opencode-sessions-cards-filter",
      placeholder: "Filter title, state, model, agent, or session ID…",
    });
    this.filterInput.addEventListener("input", () => {
      this.filterNeedle = this.filterInput.value.trim().toLowerCase();
      this.visible = this.basePageSize();
      this.render();
    });
    const refreshButton = toolbar.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => this.load());
    const newButton = toolbar.createEl("button", { text: "New session" });
    newButton.addEventListener("click", () =>
      this.plugin.newSession({ dirs: this.options.dirs, basedir: this.options.basedir }),
    );
    if (this.options.showSettings) {
      const settingsButton = toolbar.createEl("button", { text: "Settings" });
      settingsButton.addEventListener("click", () => this.plugin.openSettings());
    }

    this.errorEl = container.createDiv({ cls: "opencode-sessions-status" });
    this.listEl = container.createDiv({
      cls: this.layout() === "table" ? "opencode-sessions-table-wrap" : "opencode-sessions-cards",
    });
    this.moreButton = container.createEl("button", {
      cls: "opencode-sessions-cards-more",
      text: "Show more",
    });
    this.moreButton.addEventListener("click", () => {
      this.visible += this.basePageSize();
      this.render();
    });

    this.visible = this.basePageSize();
    this.unsubscribe = this.plugin.subscribe(() => this.load());
    await this.load();
  }

  destroy() {
    this.disposed = true;
    if (this.unsubscribe) this.unsubscribe();
  }

  async load() {
    if (this.disposed) return;
    try {
      const rows = await this.plugin.loadSessions({
        dirs: this.options.dirs,
        basedir: this.options.basedir,
      });
      if (this.disposed) return;
      this.sessions = rows;
      this.errorEl.setText("");
    } catch (error) {
      if (this.disposed) return;
      this.errorEl.setText(`OpenCode sessions unavailable: ${error.message}`);
    }
    this.render();
  }

  filteredSessions() {
    if (!this.filterNeedle) return this.sessions;
    return this.sessions.filter((session) =>
      [session.titleLabel, session.stateLabel, session.directoryLabel, session.modelLabel, session.agent, session.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(this.filterNeedle),
    );
  }

  render() {
    if (this.disposed || !this.listEl) return;
    const filtered = this.filteredSessions();
    const shown = filtered.slice(0, this.visible);
    const live = this.plugin.serverEvents?.connected ? " · live" : " · offline (db)";
    this.statusEl.setText(
      `${filtered.length} of ${this.sessions.length} session${filtered.length === 1 ? "" : "s"}${live}`,
    );
    this.listEl.empty();
    if (this.layout() === "table") {
      this.renderTable(shown);
    } else {
      this.renderCards(shown);
    }
    const remaining = filtered.length - shown.length;
    this.moreButton.setText(remaining > 0 ? `Show more (${remaining} remaining)` : "");
    this.moreButton.style.display = remaining > 0 ? "" : "none";
  }

  copyId(sessionId) {
    navigator.clipboard
      .writeText(sessionId)
      .then(() => new Notice(`Copied ${sessionId}`))
      .catch(() => new Notice(sessionId));
  }

  renderCards(sessions) {
    for (const session of sessions) {
      const card = this.listEl.createDiv({
        cls: `opencode-sessions-card opencode-sessions-card-${session.state || "none"}`,
      });
      card.addEventListener("click", () => this.plugin.openSession(session.id));
      const head = card.createDiv({ cls: "opencode-sessions-card-head" });
      const title = head.createSpan({
        cls: "opencode-sessions-card-title",
        text: session.titleLabel,
      });
      title.title = "Open session";
      head.createSpan({
        cls: `opencode-sessions-badge opencode-sessions-badge-${session.state || "none"}`,
        text: session.stateLabel,
      });
      card.createDiv({
        cls: "opencode-sessions-card-meta",
        text: [session.updatedLabel, session.directoryLabel, session.modelLabel, session.agent]
          .filter(Boolean)
          .join(" · "),
      });
      const sub = card.createDiv({ cls: "opencode-sessions-card-sub" });
      const idSpan = sub.createSpan({ cls: "opencode-sessions-mono", text: session.id });
      idSpan.title = "Copy session ID";
      idSpan.addEventListener("click", (event) => {
        event.stopPropagation();
        this.copyId(session.id);
      });
      if (session.tokensLabel) sub.appendText(` · ${session.tokensLabel} tokens`);
    }
  }

  renderTable(sessions) {
    const table = this.listEl.createEl("table", { cls: "opencode-sessions-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    ["Title", "State", "Last activity", "Model", "Agent", "Directory", "Tokens", "Session ID"].forEach(
      (label) => headerRow.createEl("th", { text: label }),
    );
    const body = table.createEl("tbody");
    for (const session of sessions) {
      const row = body.createEl("tr");
      row.addEventListener("click", () => this.plugin.openSession(session.id));
      const title = row.createEl("td", { cls: "opencode-sessions-title", text: session.titleLabel });
      title.title = "Open session";
      row.createEl("td", {
        cls: `opencode-sessions-state opencode-sessions-state-${session.state || "none"}`,
        text: session.stateLabel,
      });
      row.createEl("td", { text: session.updatedLabel });
      row.createEl("td", { text: session.modelLabel });
      row.createEl("td", { text: session.agent || "" });
      row.createEl("td", { text: session.directoryLabel });
      row.createEl("td", { text: session.tokensLabel });
      const idCell = row.createEl("td", { text: session.id, cls: "opencode-sessions-id" });
      idCell.title = "Copy session ID";
      idCell.addEventListener("click", (event) => {
        event.stopPropagation();
        this.copyId(session.id);
      });
    }
  }
}

// Wraps a dashboard embedded in a note so it is cleaned up when the
// rendered block leaves the DOM.
class SessionsDashboardChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, options) {
    super(containerEl);
    this.dashboard = plugin.createDashboard(containerEl, options);
  }

  async onload() {
    await this.dashboard.mount();
  }

  onunload() {
    this.dashboard.destroy();
  }
}

class OpenCodeSessionsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.dashboard = null;
  }

  getViewType() {
    return VIEW_TYPE_SESSIONS;
  }

  getDisplayText() {
    return "OpenCode Sessions";
  }

  async onOpen() {
    this.contentEl.addClass("opencode-sessions-view");
    if (this.dashboard) return;
    this.dashboard = this.plugin.createDashboard(this.contentEl, {
      title: "OpenCode Sessions",
      showSettings: true,
    });
    await this.dashboard.mount();
  }

  async onClose() {
    if (this.dashboard) this.dashboard.destroy();
    this.dashboard = null;
  }

  async refresh() {
    if (this.dashboard) await this.dashboard.load();
  }
}

// ---------------------------------------------------------------------------
// Session chat view. Streams the conversation in real time from the shared
// /api/event connection; prompt + interrupt included.
// ---------------------------------------------------------------------------

class SessionChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sessionId = plugin.pendingSessionId || null;
    plugin.pendingSessionId = null;
    // Draft mode: a not-yet-created session in this directory; the server
    // session is created lazily when the first message is sent.
    this.draftDirectory = plugin.pendingDraftDirectory || null;
    plugin.pendingDraftDirectory = null;
    this.session = null;
    this.offline = false;
    this.busy = false;
    this.liveOutcome = "";
    // messageID -> { el, msg, json, parts: Map(key -> {el, kind, text, ...}) }
    this.messages = new Map();
    this.order = [];
    this.cursorOlder = null;
    this.loadingOlder = false;
    this.unsubscribed = false;
    this.reconcileTimer = null;
    this.loadSeq = 0;
    this.pendingPermission = null;
    this.replyingPermission = false;
    this.lastLoadedAt = 0;
    this.refreshing = false;
  }

  getViewType() {
    return VIEW_TYPE_SESSION;
  }

  getDisplayText() {
    return this.session?.title ? `Chat: ${this.session.title}` : "OpenCode session";
  }

  getIcon() {
    return "message-square";
  }

  // Persist across Obsidian reloads: workspace.json otherwise restores
  // `"state": {}` and the tab keeps a stale title with no content.
  // Obsidian calls setState() before onOpen() on restore.
  getState() {
    return { sessionId: this.sessionId, draftDirectory: this.draftDirectory };
  }

  async setState(state) {
    if (state && typeof state === "object") {
      if (typeof state.sessionId === "string" && state.sessionId) {
        if (!this.sessionId) this.sessionId = state.sessionId;
        if (!this.draftDirectory && typeof state.draftDirectory === "string") {
          this.draftDirectory = state.draftDirectory || null;
        }
      } else if (typeof state.draftDirectory === "string" && state.draftDirectory) {
        if (!this.sessionId) this.draftDirectory = state.draftDirectory;
      }
    }
    return super.setState ? super.setState(state) : undefined;
  }

  setSession(sessionId) {
    this.sessionId = sessionId;
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("opencode-session-view");
    if (this.sessionId) {
      this.buildSkeleton();
      this.bindSession(this.sessionId);
      this.unsubscribeStream = this.plugin.subscribe(() => this.updateComposer());
      await this.loadInitial();
      return;
    }
    if (this.draftDirectory) {
      this.buildSkeleton();
      this.unsubscribeStream = this.plugin.subscribe(() => this.updateComposer());
      this.renderHeader();
      this.renderBadge();
      this.updateComposer();
      this.loadModels().catch(() => {});
      return;
    }
    this.contentEl.createDiv({ cls: "opencode-session-empty", text: "No session selected." });
  }

  // (Re)wires the per-session event listener; used on open and again when a
  // draft is promoted to a real session on the server.
  bindSession(sessionId) {
    if (this.unsubscribeEvents) this.unsubscribeEvents();
    this.sessionId = sessionId;
    this.unsubscribeEvents = this.plugin.subscribeSession(sessionId, (event) =>
      this.onServerEvent(event),
    );
  }

  async onClose() {
    this.unsubscribed = true;
    if (this.unsubscribeEvents) this.unsubscribeEvents();
    if (this.unsubscribeStream) this.unsubscribeStream();
    if (this.reconcileTimer) window.clearTimeout(this.reconcileTimer);
  }

  buildSkeleton() {
    const { contentEl } = this;
    const header = contentEl.createDiv({ cls: "oc-header" });
    const titleRow = header.createDiv({ cls: "oc-header-row" });
    this.backButton = titleRow.createEl("button", {
      cls: "oc-icon-button oc-back",
      attr: { "aria-label": "Back to sessions" },
    });
    setIcon(this.backButton, "arrow-left");
    this.backButton.addEventListener("click", () => this.plugin.activateView());
    this.titleEl = titleRow.createEl("span", { cls: "oc-title", text: this.sessionId });
    this.badgeEl = titleRow.createSpan({
      cls: "opencode-sessions-badge opencode-sessions-badge-none",
      text: "",
    });
    this.copyButton = titleRow.createEl("button", { cls: "oc-icon-button", text: "Copy ID" });
    this.copyButton.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.sessionId)
        .then(() => new Notice("Copied session ID"))
        .catch(() => new Notice(this.sessionId));
    });
    this.refreshButton = titleRow.createEl("button", { cls: "oc-icon-button oc-refresh", text: "Refresh" });
    this.refreshButton.addEventListener("click", () => this.refresh(true));
    this.metaEl = header.createDiv({ cls: "oc-meta", text: "Loading…" });
    this.offlineEl = header.createDiv({ cls: "oc-offline", text: "" });
    this.offlineEl.style.display = "none";

    // The chat trick: column-reverse keeps content attached to the bottom.
    // Newest message = FIRST DOM child (visual bottom); scrollTop 0 is the
    // bottom, so streaming growth stays pinned to the latest content without
    // any scroll juggling. "Load older" sits LAST (visual top).
    this.chatEl = contentEl.createDiv({ cls: "oc-chat" });
    this.olderButton = this.chatEl.createEl("button", {
      cls: "oc-load-older",
      text: "Load older messages",
    });
    this.olderButton.addEventListener("click", () => this.loadOlder());
    this.olderButton.style.display = "none";
    // Infinite scroll upward: in a column-reverse container scrollTop is 0 at
    // the bottom and most negative at the visual top, so hitting the top of
    // the loaded history pages in the previous 100 messages automatically.
    this.chatEl.addEventListener("scroll", () => {
      if (this.loadingOlder || !this.cursorOlder || this.offline) return;
      const el = this.chatEl;
      const visualTop = -(el.scrollHeight - el.clientHeight);
      if (el.scrollTop <= visualTop + 140) this.loadOlder();
    });

    // Permission approval banner: sits between the transcript and the
    // composer so a pending approval is always visible (the chat is
    // bottom-anchored, a banner inside the stream could scroll away).
    this.permissionEl = contentEl.createDiv({ cls: "oc-permission" });
    this.permissionEl.style.display = "none";

    const composer = contentEl.createDiv({ cls: "oc-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "Message this session… (Enter to send, Shift+Enter for newline)", rows: "1" },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    const actions = composer.createDiv({ cls: "oc-composer-actions" });
    this.modelSelect = actions.createEl("select", { cls: "oc-model-select" });
    this.modelSelect.title = "Model";
    this.modelSelect.addEventListener("change", () => this.onModelChange());
    this.hintEl = actions.createSpan({ cls: "oc-hint", text: "" });
    this.stopButton = actions.createEl("button", { cls: "oc-stop", text: "Stop" });
    this.stopButton.addEventListener("click", () => this.stop());
    this.sendButton = actions.createEl("button", { cls: "oc-send", text: "Send" });
    this.sendButton.addEventListener("click", () => this.send());

    this.updateComposer();
  }

  autoGrow() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 160)}px`;
  }

  setOffline(offline, reason = "") {
    this.offline = offline;
    this.offlineEl.setText(offline ? `Server unreachable${reason ? ` — ${reason}` : ""}. Showing messages from the local database (read-only).` : "");
    this.offlineEl.style.display = offline ? "" : "none";
    this.updateComposer();
  }

  updateComposer() {
    const connected = this.plugin.serverEvents?.connected;
    this.sendButton.disabled = !!this.offline || !this.inputEl?.value?.trim();
    this.stopButton.disabled = !!this.offline || !this.busy;
    this.stopButton.style.display = "";
    if (this.offline) {
      this.hintEl.setText("Offline — input disabled");
    } else if (this.pendingPermission) {
      this.hintEl.setText("Waiting for your approval — the session is paused");
    } else if (this.isDraft()) {
      this.hintEl.setText("Draft — your first message will create the session");
    } else if (this.busy) {
      this.hintEl.setText("Streaming… new messages attach at the bottom; Stop interrupts");
    } else if (connected) {
      this.hintEl.setText("Live — connected to the OpenCode v2 event stream");
    } else {
      this.hintEl.setText("Reconnecting…");
    }
  }

  isDraft() {
    return !this.sessionId && !!this.draftDirectory;
  }

  setBusy(busy, outcome = "") {
    this.busy = busy;
    this.liveOutcome = outcome;
    this.renderBadge();
    this.updateComposer();
  }

  renderBadge() {
    if (!this.sessionId) {
      this.badgeEl.className = `opencode-sessions-badge ${this.isDraft() ? "oc-picker-draft" : "opencode-sessions-badge-none"}`;
      this.badgeEl.setText(this.isDraft() ? "New" : "");
      return;
    }
    const live = this.plugin.getLiveState(this.sessionId);
    const state = this.pendingPermission
      ? "waiting"
      : this.busy
        ? "running"
        : live && live.status !== "running"
          ? live.status
          : "idle";
    this.badgeEl.className = `opencode-sessions-badge opencode-sessions-badge-${state}`;
    this.badgeEl.setText(STATE_LABELS[state] || "");
  }

  renderHeader() {
    if (!this.session) {
      if (this.isDraft()) {
        this.titleEl.setText("New session");
        this.metaEl.setText(
          [
            `Draft in ${this.draftDirectory}`,
            this.draftDirectory === this.plugin.vaultRoot
              ? "this vault"
              : displayDirectory(this.draftDirectory, this.plugin.vaultRoot),
          ].join(" · "),
        );
      }
      return;
    }
    this.titleEl.setText(this.session.title || "Untitled session");
    const model = this.session.model ? modelLabel(this.session.model) : "";
    const tokens = formatTokens(this.session.tokens);
    const cost = Number(this.session.cost || 0);
    const directory = this.session.location?.directory || "";
    this.metaEl.setText(
      [
        this.session.agent || "",
        model,
        directory,
        tokens ? `${tokens} tokens` : "",
        cost ? `$${cost.toFixed(2)}` : "",
        formatDate(this.session.time?.updated),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  async loadInitial() {
    const seq = ++this.loadSeq;
    try {
      const [sessionResponse, messagesResponse] = await Promise.all([
        this.plugin.client.session(this.sessionId),
        // Newest page first: order=desc guarantees the latest messages are
        // included even in long sessions (order=asc&limit returns the
        // OLDEST page — sessions over the limit lose their tail).
        this.plugin.client.messages(this.sessionId, { limit: DEFAULT_MESSAGE_PAGE, order: "desc" }),
      ]);
      if (this.unsubscribed || seq !== this.loadSeq) return;
      this.setOffline(false);
      this.session = sessionResponse?.data || null;
      this.resetMessages();
      this.appendMessages(
        [...(messagesResponse?.data || [])].reverse(),
        messagesResponse?.cursor?.next || null,
      );
      // If the session is already running (view opened mid-stream), adopt it.
      const live = this.plugin.getLiveState(this.sessionId);
      this.setBusy(live?.status === "running" || live?.status === "waiting");
      this.renderHeader();
      this.renderBadge();
      this.lastLoadedAt = Date.now();
      this.loadModels().catch(() => {});
      this.refreshPendingPermission().catch(() => {});
    } catch (error) {
      if (this.unsubscribed || seq !== this.loadSeq) return;
      this.setOffline(true, error.message);
      await this.loadFromDb();
    }
  }

  // ----- model selector ------------------------------------------------------

  modelRefKey(ref) {
    return ref ? `${ref.providerID}/${ref.id}${ref.variant ? `·${ref.variant}` : ""}` : "";
  }

  selectedModelRef() {
    if (!this.modelSelect?.value) return null;
    try {
      const ref = JSON.parse(this.modelSelect.value);
      return ref?.id && ref?.providerID ? ref : null;
    } catch {
      return null;
    }
  }

  // Populates the model dropdown: a Default entry resolved exactly like the
  // OpenCode TUI (last-used model + persisted variant from its state file,
  // falling back to the server's location-aware default), then every
  // available model grouped by provider, variants expanded inline.
  async loadModels() {
    if (!this.modelSelect) return;
    const directory = this.session?.location?.directory || this.draftDirectory;
    let models = [];
    let defaultRef = null;
    try {
      const [listResponse, resolvedDefault] = await Promise.all([
        this.plugin.client.models(directory),
        this.plugin.resolveDefaultModel(directory),
      ]);
      models = Array.isArray(listResponse?.data) ? listResponse.data : [];
      defaultRef = resolvedDefault;
    } catch {
      this.modelSelect.style.display = "none";
      return;
    }
    if (this.unsubscribed) return;
    const select = this.modelSelect;
    select.empty();

    const defaultOption = select.createEl("option", {
      value: defaultRef ? JSON.stringify(defaultRef) : "",
      text: defaultRef
        ? `Default — ${defaultRef.id}${defaultRef.variant ? ` (${defaultRef.variant})` : ""}`
        : "Default",
    });
    defaultOption.dataset.isDefault = "1";

    const byProvider = new Map();
    for (const model of models) {
      if (!model?.id || !model?.providerID) continue;
      if (!byProvider.has(model.providerID)) byProvider.set(model.providerID, []);
      byProvider.get(model.providerID).push(model);
    }
    for (const [providerID, providerModels] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = select.createEl("optgroup", { attr: { label: providerID } });
      for (const model of providerModels) {
        const base = { id: model.id, providerID };
        group.createEl("option", {
          value: JSON.stringify(base),
          text: model.name || model.id,
        });
        for (const variant of model.variants || []) {
          if (!variant?.id) continue;
          group.createEl("option", {
            value: JSON.stringify({ ...base, variant: variant.id }),
            text: `${model.name || model.id} · ${variant.id}`,
          });
        }
      }
    }

    // Reflect the session's current model (existing sessions), else keep the
    // Default entry selected so drafts visibly match OpenCode's default.
    const current = this.session?.model
      ? { id: this.session.model.id, providerID: this.session.model.providerID, ...(this.session.model.variant ? { variant: this.session.model.variant } : {}) }
      : null;
    if (current) this.selectModelRef(current, null);
    else select.value = defaultOption.value;
    select.style.display = "";
  }

  selectModelRef(ref, fallbackValue) {
    const select = this.modelSelect;
    if (!select || !ref) {
      if (select && fallbackValue !== null) select.value = fallbackValue;
      return;
    }
    const exact = this.modelRefKey(ref);
    const base = `${ref.providerID}/${ref.id}`;
    let match = null;
    let baseMatch = null;
    for (const option of select.options) {
      if (!option.value) continue;
      try {
        const parsed = JSON.parse(option.value);
        const key = this.modelRefKey(parsed);
        if (key === exact) match = option;
        if (key === base) baseMatch = baseMatch || option;
      } catch {
        // skip
      }
    }
    if (match) select.value = match.value;
    else if (baseMatch) select.value = baseMatch.value;
    else {
      const injected = select.createEl("option", {
        value: JSON.stringify(ref),
        text: `${ref.id}${ref.variant ? ` (${ref.variant})` : ""}`,
      });
      select.value = injected.value;
    }
  }

  async onModelChange() {
    if (this.isDraft()) return; // stored in the select; applied at creation
    const ref = this.selectedModelRef();
    if (!ref || !this.sessionId) return;
    const current = this.session?.model;
    if (
      current &&
      current.id === ref.id &&
      current.providerID === ref.providerID &&
      (current.variant || null) === (ref.variant || null)
    ) {
      return;
    }
    try {
      await this.plugin.client.setSessionModel(this.sessionId, ref);
      this.session = { ...this.session, model: ref };
      this.renderHeader();
      new Notice(`Model switched to ${ref.id}${ref.variant ? ` (${ref.variant})` : ""}`);
    } catch (error) {
      new Notice(`Could not switch model: ${error.message}`);
      this.selectModelRef(current || null, null);
    }
  }

  // Manual + automatic refresh entry points (header button, tab focus,
  // stream reconnect, layout-ready). Full reload when idle; non-destructive
  // upsert when streaming so live deltas are not clobbered.
  async refresh(manual = false) {
    if (!this.sessionId || this.refreshing || this.unsubscribed) return;
    if (this.isDraft()) return;
    if (this.busy && !manual) {
      await this.reconcileNow();
      return;
    }
    this.refreshing = true;
    if (this.refreshButton) {
      this.refreshButton.disabled = true;
      this.refreshButton.setText("Refreshing…");
    }
    try {
      await this.loadInitial();
    } finally {
      this.refreshing = false;
      if (this.refreshButton) {
        this.refreshButton.disabled = false;
        this.refreshButton.setText("Refresh");
      }
    }
  }

  // Called when the leaf becomes active (page load / tab switch back).
  // Skips fresh views and live streams; reloads stale (>30s) or offline views.
  async onBecameActive() {
    await this.refreshIfStale();
  }

  async refreshIfStale(options = {}) {
    const { force = false } = options;
    if (!this.sessionId || this.refreshing || this.unsubscribed || this.isDraft()) return;
    if (this.busy && !force) return;
    const staleMs = Date.now() - (this.lastLoadedAt || 0);
    if (!force && !this.offline && this.lastLoadedAt && staleMs < 30000) return;
    await this.refresh(force);
  }

  // Stream was lost and recovered: SSE deltas in the gap are gone for good,
  // so reconcile against the server immediately.
  async refreshAfterReconnect() {
    if (!this.sessionId || this.unsubscribed || this.isDraft()) return;
    if (this.busy) await this.reconcileNow();
    else await this.refresh(false);
  }

  // Offline fallback: session row + messages straight from SQLite.
  async loadFromDb() {
    try {
      const row = await this.plugin.loadSessionFromDb(this.sessionId);
      if (row) {
        this.session = {
          id: row.id,
          title: row.title,
          agent: row.agent || "",
          model: row.model || null,
          cost: row.cost,
          tokens: {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
          },
          time: { created: row.time_created, updated: row.time_updated },
          location: { directory: row.directory },
        };
      }
      const messages = await this.plugin.loadMessagesFromDb(this.sessionId);
      if (this.unsubscribed) return;
      this.resetMessages();
      this.appendMessages(messages, null);
      this.renderHeader();
      this.renderBadge();
    } catch (error) {
      this.metaEl.setText(`Could not load session: ${error.message}`);
    }
  }

  resetMessages() {
    this.chatEl.findAll(".oc-msg").forEach((el) => el.remove());
    this.messages.clear();
    this.order = [];
    this.cursorOlder = null;
    this.olderButton.style.display = "none";
  }

  // `cursorOlder` continues pagination toward older messages (cursor-only
  // requests; with order=desc the "next" cursor pages older).
  appendMessages(list, cursorOlder) {
    for (const message of list || []) {
      this.upsertMessage(message);
    }
    if (cursorOlder !== null && cursorOlder !== undefined) {
      this.cursorOlder = cursorOlder;
    }
    this.olderButton.style.display = this.cursorOlder ? "" : "none";
  }

  // Creates or updates a message element. Returns the message record.
  upsertMessage(message) {
    if (!message || !message.id) return null;
    let record = this.messages.get(message.id);
    const json = JSON.stringify(this.stableMessage(message));
    if (record) {
      if (record.json !== json) {
        record.json = json;
        record.msg = message;
        this.renderMessageBody(record);
      }
      return record;
    }
    const el = this.chatEl.createDiv({ cls: "oc-msg", attr: { "data-id": message.id } });
    // column-reverse chat: the FIRST DOM child is the visual bottom, so
    // inserting before the current first child attaches new messages at the
    // end of the conversation (the "Load older" button stays last = top).
    this.chatEl.insertBefore(el, this.chatEl.firstElementChild);
    record = { el, msg: message, json, parts: new Map(), streaming: false };
    this.messages.set(message.id, record);
    this.order.push(message.id);
    this.renderMessageBody(record);
    return record;
  }

  stableMessage(message) {
    const { id, type, time, text, agent, model, content, error, finish } = message;
    return { id, type, time, text, agent, model, content, error, finish };
  }

  renderMessageBody(record) {
    const { el, msg } = record;
    el.empty();
    el.className = `oc-msg oc-msg-${msg.type || "system"}`;
    if (msg.type === "user") {
      const bubble = el.createDiv({ cls: "oc-bubble oc-bubble-user" });
      bubble.setText(String(msg.text ?? ""));
      this.renderAttachments(bubble, msg);
      return;
    }
    if (msg.type === "assistant") {
      const meta = el.createDiv({ cls: "oc-msg-meta" });
      meta.createSpan({ cls: "oc-msg-agent", text: msg.agent || "assistant" });
      if (msg.model) meta.appendText(` · ${modelLabel(msg.model)}`);
      meta.appendText(` · ${formatTime(msg.time?.created || msg.time?.streamed)}`);
      if (msg.error) {
        el.createDiv({
          cls: "oc-msg-error",
          text: `Error: ${msg.error.message || msg.error.type || "unknown"}`,
        });
      }
      const body = el.createDiv({ cls: "oc-msg-body" });
      const content = Array.isArray(msg.content) ? msg.content : [];
      record.parts.clear();
      content.forEach((item, index) => {
        this.renderContentItem(body, record, item, index);
      });
      if (!content.length) {
        record.emptyEl = body.createDiv({ cls: "oc-msg-pending", text: "…" });
      } else {
        record.emptyEl = null;
      }
      return;
    }
    // system / synthetic / compaction / agent-switched / model-switched / …
    const note = el.createDiv({ cls: "oc-note" });
    const label = String(msg.type || "system").replaceAll("-", " ");
    note.createSpan({ cls: "oc-note-kind", text: label });
    if (msg.text) note.createSpan({ text: ` — ${msg.text}` });
  }

  renderAttachments(container, msg) {
    const chips = [...(msg.files || []), ...(msg.agents || []), ...(msg.skills || [])];
    if (!chips.length) return;
    const wrap = container.createDiv({ cls: "oc-attachments" });
    for (const chip of chips) {
      wrap.createSpan({ cls: "oc-chip", text: chip.name || chip.id || "attachment" });
    }
  }

  renderContentItem(container, record, item, index) {
    if (!item) return;
    if (item.type === "text") {
      const el = container.createDiv({ cls: "oc-text" });
      record.parts.set(`text:${index}`, { el, kind: "text", markdown: true });
      this.renderTextPart(el, item.text, true);
    } else if (item.type === "reasoning") {
      const details = container.createEl("details", { cls: "oc-reasoning" });
      details.createEl("summary", { text: "Thinking" });
      const body = details.createDiv({ cls: "oc-reasoning-body" });
      record.parts.set(`reasoning:${index}`, { el: body, details, kind: "reasoning" });
      this.renderTextPart(body, item.text, false);
    } else if (item.type === "tool") {
      const part = this.renderToolPart(container, item);
      record.parts.set(`tool:${item.id || `idx:${index}`}`, part);
    }
  }

  renderTextPart(el, text, markdown) {
    if (markdown && el.dataset.rendered !== "streaming") {
      el.empty();
      MarkdownRenderer.render(this.app, String(text || ""), el, "", this).catch(() => {
        el.setText(String(text || ""));
      });
    } else {
      el.setText(String(text || ""));
    }
  }

  renderToolPart(container, item) {
    const wrap = container.createDiv({ cls: "oc-tool" });
    const head = wrap.createDiv({ cls: "oc-tool-head" });
    head.createSpan({ cls: "oc-tool-dot" });
    const nameEl = head.createSpan({ cls: "oc-tool-name", text: item.name || "tool" });
    const statusEl = head.createSpan({ cls: "oc-tool-status" });
    const inputDetails = wrap.createEl("details", { cls: "oc-tool-io" });
    inputDetails.createEl("summary", { text: "Input" });
    const inputEl = inputDetails.createEl("pre", { cls: "oc-tool-input" });
    const outputWrap = wrap.createDiv({ cls: "oc-tool-output-wrap" });
    const state = item.state || {};
    const setStatus = (text, cls) => {
      statusEl.setText(text);
      statusEl.className = `oc-tool-status ${cls || ""}`;
      wrap.className = `oc-tool ${cls ? `is-${cls.replace("is-", "")}` : ""}`.trim();
    };
    const setInput = (value) => {
      inputEl.setText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    };
    setInput(state.input ?? item.input ?? "");
    if (state.status === "streaming") setStatus("streaming input…", "is-running");
    else if (state.status === "running") setStatus("running…", "is-running");
    else if (state.status === "completed") setStatus("done", "is-done");
    else if (state.status === "error") setStatus("failed", "is-error");
    else setStatus("");
    if (Array.isArray(state.content) && state.content.length) {
      this.renderToolOutput(outputWrap, state.content);
    }
    if (state.error) {
      outputWrap.createDiv({ cls: "oc-msg-error", text: `Error: ${state.error.message || state.error.type || "tool failed"}` });
    }
    return { el: wrap, kind: "tool", nameEl, statusEl, inputEl, outputWrap, setInput, setStatus };
  }

  renderToolOutput(wrap, content) {
    wrap.empty();
    const details = wrap.createEl("details", { cls: "oc-tool-io" });
    details.createEl("summary", { text: "Output" });
    for (const block of content || []) {
      if (block?.type === "text") {
        details.createEl("pre", { cls: "oc-tool-output", text: String(block.text ?? "") });
      }
    }
  }

  // ----- live streaming ----------------------------------------------------

  onServerEvent(event) {
    if (this.unsubscribed) return;
    const type = String(event.type || "");
    const data = event.data || {};
    switch (type) {
      case "session.execution.started":
        this.setBusy(true);
        break;
      case "session.execution.succeeded":
        this.setBusy(false, "succeeded");
        this.scheduleReconcile();
        break;
      case "session.execution.interrupted":
        this.setBusy(false, "interrupted");
        this.scheduleReconcile();
        break;
      case "session.execution.failed":
        this.setBusy(false, "failed");
        this.scheduleReconcile();
        break;
      case "session.renamed":
        if (this.session) {
          this.session.title = data.title;
          this.renderHeader();
        }
        this.titleEl.setText(data.title || this.titleEl.getText());
        break;
      case "session.usage.updated":
        if (this.session) {
          this.session.cost = data.cost ?? this.session.cost;
          this.session.tokens = data.tokens || this.session.tokens;
          this.renderHeader();
        }
        break;
      case "session.inbox.enqueued":
        if (data.item?.type === "user") {
          this.upsertMessage({
            id: data.inboxID,
            type: "user",
            time: { created: event.created || Date.now() },
            text: data.item.payload?.text || "",
            files: data.item.payload?.files,
            agents: data.item.payload?.agents,
            skills: data.item.payload?.skills,
          });
        }
        break;
      case "session.step.started":
        this.ensureAssistantMessage(data.assistantMessageID, data.agent, data.model);
        this.setBusy(true);
        break;
      case "session.reasoning.started":
        this.beginStreamPart(data.assistantMessageID, "reasoning", data.ordinal);
        break;
      case "session.reasoning.delta":
        this.appendStreamDelta(data.assistantMessageID, "reasoning", data.delta);
        break;
      case "session.reasoning.ended":
        this.endStreamPart(data.assistantMessageID, "reasoning", data.text);
        break;
      case "session.text.started":
        this.beginStreamPart(data.assistantMessageID, "text", data.ordinal);
        break;
      case "session.text.delta":
        this.appendStreamDelta(data.assistantMessageID, "text", data.delta);
        break;
      case "session.text.ended":
        this.endStreamPart(data.assistantMessageID, "text", data.text);
        break;
      case "session.tool.input.started":
        this.beginToolPart(data.assistantMessageID, data.id, data.name);
        break;
      case "session.tool.input.ended":
        this.updateToolPart(data.assistantMessageID, data.id, (part) => {
          part.setInput(data.text);
        });
        break;
      case "session.tool.called":
        this.updateToolPart(data.assistantMessageID, data.id, (part) => {
          if (data.input !== undefined) part.setInput(data.input);
          part.setStatus("running…", "is-running");
        });
        break;
      case "session.tool.progress":
        this.updateToolPart(data.assistantMessageID, data.id, (part) => {
          part.setStatus("running…", "is-running");
        });
        break;
      case "session.tool.success":
        this.finishToolPart(data.assistantMessageID, data.id, data, false);
        break;
      case "session.tool.failed":
        this.finishToolPart(data.assistantMessageID, data.id, data, true);
        break;
      case "session.step.ended":
        this.finalizeStep(data);
        break;
      case "permission.asked":
        this.setPendingPermission(data);
        break;
      case "permission.replied":
        // Covers replies made anywhere (this banner, the TUI, elsewhere).
        this.clearPendingPermission(data?.requestID);
        break;
      default:
        break;
    }
  }

  // ----- permission handling --------------------------------------------------

  setPendingPermission(request) {
    if (!request?.id || !this.sessionId) return;
    this.pendingPermission = {
      id: request.id,
      action: request.action || "permission",
      resources: Array.isArray(request.resources) ? request.resources : [],
      save: Array.isArray(request.save) ? request.save : [],
      message: request.message || "",
    };
    this.renderPermissionBanner();
    this.renderBadge();
    this.updateComposer();
  }

  clearPendingPermission(requestId) {
    if (!this.pendingPermission) return;
    if (requestId && this.pendingPermission.id !== requestId) return;
    this.pendingPermission = null;
    this.renderPermissionBanner();
    this.renderBadge();
    this.updateComposer();
  }

  // Recovers a pending approval on view open / refresh (e.g. a session that
  // was already waiting, or a reply made while this tab was reconnecting).
  async refreshPendingPermission() {
    if (!this.sessionId || this.offline) return;
    try {
      const response = await this.plugin.client.sessionPermissions(this.sessionId);
      if (this.unsubscribed) return;
      const pending = (response?.data || [])[0] || null;
      if (pending) {
        this.setPendingPermission(pending);
      } else if (this.pendingPermission) {
        this.clearPendingPermission();
      }
    } catch {
      // server hiccup — the event stream keeps us informed anyway
    }
  }

  renderPermissionBanner() {
    const banner = this.permissionEl;
    if (!banner) return;
    banner.empty();
    if (!this.pendingPermission) {
      banner.style.display = "none";
      return;
    }
    const { action, resources, save } = this.pendingPermission;
    banner.style.display = "";
    const head = banner.createDiv({ cls: "oc-permission-head" });
    setIcon(head.createSpan({ cls: "oc-permission-icon" }), "shield-alert");
    head.createSpan({
      cls: "oc-permission-title",
      text: `Needs approval — ${String(action).replaceAll("_", " ")}`,
    });
    if (resources.length) {
      const list = banner.createDiv({ cls: "oc-permission-resources" });
      for (const resource of resources) {
        list.createEl("span", { cls: "oc-permission-resource", text: resource });
      }
    }
    if (save.length) {
      banner.createDiv({
        cls: "oc-permission-save",
        text: `"Always" saves a rule for ${save.join(", ")}`,
      });
    }
    const actions = banner.createDiv({ cls: "oc-permission-actions" });
    const reject = actions.createEl("button", { cls: "oc-permission-reject", text: "Reject" });
    reject.addEventListener("click", () => this.replyToPermission("reject"));
    if (save.length) {
      const always = actions.createEl("button", { cls: "oc-permission-always", text: "Always allow" });
      always.addEventListener("click", () => this.replyToPermission("always"));
    }
    const allow = actions.createEl("button", { cls: "oc-permission-allow", text: "Allow" });
    allow.addEventListener("click", () => this.replyToPermission("once"));
  }

  async replyToPermission(reply) {
    const pending = this.pendingPermission;
    if (!pending || this.replyingPermission) return;
    this.replyingPermission = true;
    try {
      await this.plugin.client.replyPermission(this.sessionId, pending.id, reply);
      this.clearPendingPermission(pending.id);
      new Notice(`Permission ${reply === "reject" ? "rejected" : reply === "always" ? "saved as always-allow" : "approved"}`);
    } catch (error) {
      // Already answered elsewhere (TUI, another tab): 404 — just clear it.
      if (String(error.message).startsWith("404")) {
        this.clearPendingPermission(pending.id);
      } else {
        new Notice(`Permission reply failed: ${error.message}`);
      }
    } finally {
      this.replyingPermission = false;
    }
  }

  ensureAssistantMessage(messageId, agent, model) {
    if (!messageId) return null;
    const existing = this.messages.get(messageId);
    if (existing) return existing;
    return this.upsertMessage({
      id: messageId,
      type: "assistant",
      time: { created: Date.now() },
      agent: agent || "",
      model: model || null,
      content: [],
    });
  }

  recordFor(messageId) {
    return this.messages.get(messageId) || null;
  }

  beginStreamPart(messageId, kind, ordinal) {
    const record = this.recordFor(messageId);
    if (!record) return;
    if (record.emptyEl) {
      record.emptyEl.remove();
      record.emptyEl = null;
    }
    const body = record.el.querySelector(".oc-msg-body");
    if (!body) return;
    if (kind === "reasoning") {
      const details = body.createEl("details", { cls: "oc-reasoning is-streaming" });
      details.open = true;
      details.createEl("summary", { text: "Thinking…" });
      const el = details.createDiv({ cls: "oc-reasoning-body" });
      record.parts.set(`live:${kind}`, { el, details, kind, buffer: "" });
    } else {
      const el = body.createDiv({ cls: "oc-text is-streaming" });
      el.dataset.rendered = "streaming";
      record.parts.set(`live:${kind}`, { el, kind, buffer: "" });
    }
  }

  appendStreamDelta(messageId, kind, delta) {
    if (delta === undefined || delta === null) return;
    const record = this.recordFor(messageId);
    const part = record?.parts.get(`live:${kind}`);
    if (!part) return;
    part.buffer = (part.buffer || "") + delta;
    this.throttledPartUpdate(part, () => {
      part.el.setText(part.buffer);
    });
  }

  endStreamPart(messageId, kind, text) {
    const record = this.recordFor(messageId);
    const part = record?.parts.get(`live:${kind}`);
    if (!part) return;
    const finalText = typeof text === "string" ? text : part.buffer || "";
    record.parts.delete(`live:${kind}`);
    if (part.details) {
      part.details.removeClass("is-streaming");
      part.details.open = false;
      part.details.querySelector("summary")?.setText("Thinking");
      part.el.setText(finalText);
    } else if (part.kind === "text") {
      part.el.removeClass("is-streaming");
      delete part.el.dataset.rendered;
      this.renderTextPart(part.el, finalText, true);
    }
  }

  beginToolPart(messageId, callId, name) {
    const record = this.recordFor(messageId);
    if (!record || !callId) return;
    if (record.emptyEl) {
      record.emptyEl.remove();
      record.emptyEl = null;
    }
    const key = `tool:${callId}`;
    if (record.parts.has(key)) return;
    const body = record.el.querySelector(".oc-msg-body");
    if (!body) return;
    const part = this.renderToolPart(body, { name, state: { status: "streaming", input: "" } });
    record.parts.set(key, part);
  }

  updateToolPart(messageId, callId, update) {
    const record = this.recordFor(messageId);
    const part = record?.parts.get(`tool:${callId}`);
    if (!part || typeof update !== "function") return;
    update(part);
  }

  finishToolPart(messageId, callId, data, failed) {
    this.updateToolPart(messageId, callId, (part) => {
      if (failed) {
        part.setStatus("failed", "is-error");
        if (data.error) {
          part.outputWrap.createDiv({
            cls: "oc-msg-error",
            text: `Error: ${data.error.message || data.error.type || "tool failed"}`,
          });
        }
      } else {
        part.setStatus("done", "is-done");
        if (Array.isArray(data.content)) this.renderToolOutput(part.outputWrap, data.content);
      }
    });
  }

  finalizeStep(data) {
    const record = this.recordFor(data.assistantMessageID);
    if (!record) return;
    const tokens = formatTokens(data.tokens);
    if (tokens) {
      const meta = record.el.querySelector(".oc-msg-meta");
      if (meta) {
        if (!record.stepTokensEl || !record.stepTokensEl.isConnected) {
          record.stepTokensEl = meta.createSpan({ cls: "oc-msg-step-tokens" });
        }
        record.stepTokensEl.setText(` · ${tokens} tok`);
      }
    }
  }

  throttledPartUpdate(part, apply) {
    apply();
    // Deltas arrive in bursts; DOM writes above are cheap textContent sets,
    // so a per-part throttle is enough without a scheduler.
  }

  scheduleReconcile() {
    if (this.reconcileTimer) window.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = window.setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcileNow();
    }, 700);
  }

  // Non-destructive reconcile: upserts latest messages + session header
  // without resetting the DOM (safe mid-stream, after reconnect, on focus).
  async reconcileNow() {
    if (this.unsubscribed || this.offline || !this.sessionId || this.isDraft()) return;
    try {
      const limit = Math.max(DEFAULT_MESSAGE_PAGE, this.messages.size);
      const response = await this.plugin.client.messages(this.sessionId, { limit, order: "desc" });
      if (this.unsubscribed) return;
      for (const message of [...(response?.data || [])].reverse()) {
        this.upsertMessage(message);
      }
      const sessionResponse = await this.plugin.client.session(this.sessionId).catch(() => null);
      if (!this.unsubscribed && sessionResponse?.data) {
        this.session = sessionResponse.data;
        this.renderHeader();
      }
      this.lastLoadedAt = Date.now();
      if (this.offline) this.setOffline(false);
      this.refreshPendingPermission().catch(() => {});
    } catch {
      // ignore — the next event or manual refresh will retry
    }
  }

  async loadOlder() {
    if (this.loadingOlder || !this.cursorOlder || this.offline) return;
    this.loadingOlder = true;
    this.olderButton.setText("Loading…");
    const chat = this.chatEl;
    const beforeHeight = chat.scrollHeight;
    const beforeTop = chat.scrollTop;
    try {
      // Cursor-only request (cursors must not combine with order); pages
      // continue toward older messages in newest→oldest order.
      const response = await this.plugin.client.messages(this.sessionId, {
        limit: DEFAULT_MESSAGE_PAGE,
        cursor: this.cursorOlder,
      });
      const list = response?.data || [];
      this.cursorOlder = response?.cursor?.next || null;
      // Older messages belong at the visual top = END of the DOM (the chat
      // is column-reverse). Batches arrive newest→oldest, so inserting each
      // before the "Load older" button keeps the DOM chronologically
      // newest-first.
      for (const message of list) {
        if (this.messages.has(message.id)) continue;
        const el = this.renderOlderMessageEl(message);
        chat.insertBefore(el, this.olderButton);
      }
      // Keep the viewport on the same content: content was added above
      // (column-reverse scrollTop is 0 at the bottom, negative upward).
      chat.scrollTop = beforeTop - (chat.scrollHeight - beforeHeight);
    } catch (error) {
      new Notice(`Could not load older messages: ${error.message}`);
    } finally {
      this.loadingOlder = false;
      this.olderButton.setText("Load older messages");
      this.olderButton.style.display = this.cursorOlder ? "" : "none";
    }
  }

  renderOlderMessageEl(message) {
    const record = { el: null, msg: message, json: "", parts: new Map() };
    const el = createDiv({ cls: "oc-msg" });
    record.el = el;
    this.renderMessageBody(record);
    this.messages.set(message.id, record);
    this.order.unshift(message.id);
    return el;
  }

  async send() {
    if (this.offline) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.isDraft()) {
      await this.sendDraft(text);
      return;
    }
    this.inputEl.value = "";
    this.autoGrow();
    this.updateComposer();
    try {
      const response = await this.plugin.client.prompt(this.sessionId, text);
      const user = response?.data;
      this.upsertMessage({
        id: user?.id || `local-${Date.now()}`,
        type: "user",
        time: { created: user?.timeCreated || Date.now() },
        text: user?.payload?.text || text,
      });
      this.setBusy(true);
    } catch (error) {
      new Notice(`Send failed: ${error.message}`);
      this.inputEl.value = text;
      this.autoGrow();
    }
    this.updateComposer();
  }

  // Drafts create the server session lazily with the first message, so no
  // empty sessions pile up when a draft is abandoned.
  async sendDraft(text) {
    try {
      const created = await this.plugin.client.request("/api/session", {
        method: "POST",
        body: {
          location: { directory: this.draftDirectory },
          model: this.selectedModelRef() || undefined,
        },
      });
      const session = created?.data;
      if (!session?.id) throw new Error("server returned no session id");
      this.draftDirectory = null;
      this.session = session;
      this.bindSession(session.id);
      this.renderHeader();
      this.renderBadge();
      this.inputEl.value = "";
      this.autoGrow();
      const response = await this.plugin.client.prompt(session.id, text);
      const user = response?.data;
      this.upsertMessage({
        id: user?.id || `local-${Date.now()}`,
        type: "user",
        time: { created: user?.timeCreated || Date.now() },
        text: user?.payload?.text || text,
      });
      this.setBusy(true);
    } catch (error) {
      new Notice(`Could not create session: ${error.message}`);
    }
    this.updateComposer();
  }

  async stop() {
    if (this.offline || !this.sessionId) return;
    try {
      const response = await this.plugin.client.interrupt(this.sessionId);
      if (response && response.interrupted) {
        new Notice("Session interrupted");
      }
    } catch (error) {
      new Notice(`Stop failed: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// New-session directory picker: card list of the configured working
// directories; picking one opens a draft chat in a new tab.
// ---------------------------------------------------------------------------

class NewSessionView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.directories = plugin.pendingPickerDirectories || null;
    plugin.pendingPickerDirectories = null;
  }

  getViewType() {
    return VIEW_TYPE_NEW_SESSION;
  }

  getDisplayText() {
    return "New OpenCode session";
  }

  getIcon() {
    return "plus";
  }

  setDirectories(directories) {
    this.directories = directories;
    if (this.contentEl) this.render();
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("opencode-new-session-view");
    this.render();
  }

  render() {
    const { contentEl } = this;
    if (!this.directories) return;
    contentEl.empty();
    const header = contentEl.createDiv({ cls: "oc-picker-header" });
    header.createEl("h2", { text: "New OpenCode session" });
    header.createDiv({
      cls: "oc-picker-sub",
      text: "Pick a working directory — the session is created when you send the first message.",
    });
    const cards = contentEl.createDiv({ cls: "opencode-sessions-cards" });
    for (const directory of this.directories) {
      const card = cards.createDiv({ cls: "opencode-sessions-card" });
      card.addEventListener("click", () => this.plugin.openSessionDraft(directory));
      const head = card.createDiv({ cls: "opencode-sessions-card-head" });
      const titleWrap = head.createSpan({ cls: "oc-picker-title" });
      setIcon(titleWrap.createSpan({ cls: "oc-picker-icon" }), "folder");
      titleWrap.createSpan({
        cls: "opencode-sessions-card-title",
        text: directory === this.plugin.vaultRoot ? "This vault" : path.basename(directory) || directory,
      });
      card.createDiv({
        cls: "opencode-sessions-card-meta",
        text: displayDirectory(directory, this.plugin.vaultRoot),
      });
      card.createDiv({
        cls: "opencode-sessions-card-sub",
        text: directory,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class OpenCodeSessionsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OpenCode Sessions" });

    containerEl.createEl("h3", { text: "OpenCode server (v2 API)" });
    const statusEl = containerEl.createDiv({ cls: "opencode-sessions-status", text: "Checking…" });
    const refreshStatus = async () => {
      try {
        const health = await this.plugin.client.health();
        const endpoint = this.plugin.client.endpoint;
        statusEl.setText(
          `Connected${endpoint ? ` to ${endpoint.baseUrl}` : ""} — OpenCode v${health.version} (pid ${health.pid}). Event stream: ${this.plugin.serverEvents.connected ? "live" : "connecting…"}`,
        );
      } catch {
        statusEl.setText(
          "Server unreachable — dashboards fall back to SQLite polling; chat and input are disabled until it returns.",
        );
      }
    };
    refreshStatus();
    if (!this.statusTimer) {
      this.statusTimer = window.setInterval(() => {
        if (statusEl.isConnected) refreshStatus();
      }, 15000);
    }

    new Setting(containerEl)
      .setName("Server URL override")
      .setDesc("Leave empty to auto-discover via ~/.local/state/opencode/service.json (recommended).")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:49374")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
            this.plugin.client.invalidate();
            this.plugin.restartServerConnection();
          }),
      );

    new Setting(containerEl)
      .setName("Server password override")
      .setDesc("Basic-auth password. Leave empty to use the discovered service credentials.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.apiPassword)
          .onChange(async (value) => {
            this.plugin.settings.apiPassword = value.trim();
            await this.plugin.saveSettings();
            this.plugin.client.invalidate();
            this.plugin.restartServerConnection();
          }),
      );

    containerEl.createEl("h3", { text: "Session database (SQLite)" });

    new Setting(containerEl)
      .setName("OpenCode database")
      .setDesc("Read-only SQLite database used by OpenCode v2 (session_v2).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.databasePath)
          .onChange(async (value) => {
            this.plugin.settings.databasePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("sqlite3 executable")
      .setDesc("Usually just sqlite3, or an absolute path to the executable.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.sqlitePath)
          .onChange(async (value) => {
            this.plugin.settings.sqlitePath = value.trim() || defaultSqlitePath();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Directories")
      .setDesc("One OpenCode working directory per line. Add historical aliases if needed.")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.directories.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.directories = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Custom SQL")
      .setDesc("Optional SQL WHERE fragment appended after directory IN (...). Example: title LIKE '%pipeline%'.")
      .addTextArea((text) => {
        text
          .setPlaceholder("title LIKE '%pipeline%'")
          .setValue(this.plugin.settings.customSql)
          .onChange(async (value) => {
            this.plugin.settings.customSql = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Refresh interval")
      .setDesc("Seconds between automatic SQLite refreshes (the event stream refreshes instantly when connected). Use 0 to disable.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.refreshSeconds))
          .onChange(async (value) => {
            const seconds = Math.max(0, Number.parseInt(value, 10) || 0);
            this.plugin.settings.refreshSeconds = seconds;
            await this.plugin.saveSettings();
            this.plugin.configureRefreshTimer();
          }),
      );

    new Setting(containerEl)
      .setName("Items per page")
      .setDesc("Sessions shown per dashboard page by default. Code blocks can override this with pageSize.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pageSize))
          .onChange(async (value) => {
            const items = Math.max(1, Number.parseInt(value, 10) || DEFAULT_PAGE_SIZE);
            this.plugin.settings.pageSize = items;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Open dashboard")
      .setDesc("Open the sessions table in a new Obsidian tab.")
      .addButton((button) => button.setButtonText("Open").onClick(() => this.plugin.activateView()));
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class OpenCodeSessionsPlugin extends Plugin {
  async onload() {
    this.vaultRoot = this.app.vault.adapter?.basePath || "";
    const saved = (await this.loadData()) || {};
    this.settings = {
      databasePath: saved.databasePath || defaultDatabasePath(),
      sqlitePath: saved.sqlitePath || defaultSqlitePath(),
      // v2 only: the legacy v1 "session" table backend is gone.
      databaseKind: "opencode2",
      directories: Array.isArray(saved.directories) && saved.directories.length
        ? saved.directories
        : [this.vaultRoot].filter(Boolean),
      customSql: typeof saved.customSql === "string" ? saved.customSql : "",
      pageSize: Number.isFinite(saved.pageSize) && saved.pageSize > 0 ? saved.pageSize : DEFAULT_PAGE_SIZE,
      refreshSeconds: Number.isFinite(saved.refreshSeconds)
        ? saved.refreshSeconds
        : DEFAULT_REFRESH_SECONDS,
      apiBaseUrl: typeof saved.apiBaseUrl === "string" ? saved.apiBaseUrl : "",
      apiPassword: typeof saved.apiPassword === "string" ? saved.apiPassword : "",
    };
    if (saved.databaseKind === "opencode") {
      await this.saveData(this.settings); // migrate away from the v1 backend
    }

    this.listeners = new Set();
    // sessionID -> Set<listener(event)> for open chat views.
    this.sessionListeners = new Map();
    // sessionID -> { status, at } live states from the event stream.
    this.liveStates = new Map();
    this.listRefreshTimer = null;
    this.pendingSessionId = null;
    this.pendingDraftDirectory = null;
    this.pendingPickerDirectories = null;

    this.client = new OpenCodeClient(this);
    this.serverEvents = new ServerEventStream(this);
    this.serverEvents.start();

    this.api = {
      apiVersion: 3,
      list: (query) => this.loadSessions(query),
      listSessions: (query) => this.loadSessions(query),
      refresh: async () => {
        const rows = await this.loadSessions();
        this.emitChange();
        return rows;
      },
      subscribe: (listener) => this.subscribe(listener),
      config: () => ({
        databasePath: this.settings.databasePath,
        directories: [...this.settings.directories],
        customSql: this.settings.customSql,
        refreshSeconds: this.settings.refreshSeconds,
        pageSize: this.settings.pageSize,
        server: this.client.endpoint,
        eventsConnected: this.serverEvents.connected,
      }),
      open: (sessionId) => this.openSession(sessionId),
      server: {
        connected: () => this.serverEvents.connected,
        health: () => this.client.health(),
        session: (sessionId) => this.client.session(sessionId),
        messages: (sessionId, options) => this.client.messages(sessionId, options),
        prompt: (sessionId, text) => this.client.prompt(sessionId, text),
        stop: (sessionId) => this.client.interrupt(sessionId),
      },
    };
    this.api.getConfig = this.api.config;
    globalThis.opencodeSessions = this.api;

    this.registerView(VIEW_TYPE_SESSIONS, (leaf) => new OpenCodeSessionsView(leaf, this));
    this.registerView(VIEW_TYPE_SESSION, (leaf) => new SessionChatView(leaf, this));
    this.registerView(VIEW_TYPE_NEW_SESSION, (leaf) => new NewSessionView(leaf, this));
    // Note-embeddable dashboards: ```opencode-sessions blocks render the same
    // dashboard as the view, configured by the block body.
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
      let options;
      try {
        options = parseBlockConfig(source);
      } catch (error) {
        el.createEl("pre").setText(`opencode-sessions error: ${error.message}`);
        return;
      }
      ctx.addChild(new SessionsDashboardChild(el, this, options));
    });
    this.addCommand({
      id: "open-sessions",
      name: "Open OpenCode sessions",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "new-session",
      name: "New OpenCode session",
      callback: () => this.newSession(),
    });
    this.addRibbonIcon("messages-square", "Open OpenCode sessions", () => this.activateView());
    this.addSettingTab(new OpenCodeSessionsSettingTab(this.app, this));
    this.configureRefreshTimer();
    // (1) Refresh on page load / tab focus: Obsidian restores custom views
    // without calling onOpen again, so an old tab would sit stale forever.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof SessionChatView) {
          leaf.view.onBecameActive().catch(() => {});
        } else if (leaf && leaf.view instanceof OpenCodeSessionsView) {
          leaf.view.refresh().catch(() => {});
        }
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.refreshOpenSessions("layout-ready").catch(() => {});
    });
    this.addCommand({
      id: "refresh-open-sessions",
      name: "Refresh open sessions",
      callback: () => this.refreshOpenSessions("manual"),
    });
  }

  onunload() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.listRefreshTimer) window.clearTimeout(this.listRefreshTimer);
    this.serverEvents.stop();
    this.listeners.clear();
    this.sessionListeners.clear();
    if (globalThis.opencodeSessions === this.api) delete globalThis.opencodeSessions;
  }

  // Push-based change notification: consumers (e.g. Datacore JSX views)
  // subscribe instead of running their own polling timers.
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSession(sessionId, listener) {
    if (typeof listener !== "function") return () => {};
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.sessionListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.sessionListeners.delete(sessionId);
    };
  }

  emitChange() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("OpenCode Sessions listener failed:", error);
      }
    }
  }

  // ----- v2 event stream handling -------------------------------------------

  handleServerEvent(event) {
    const type = String(event.type || "");
    const data = event.data || {};
    if (type === "server.instance.disposed") {
      this.client.invalidate();
      this.liveStates.clear();
      this.serverEvents.reconnectSoon(1000);
      return;
    }
    const sessionId = data.sessionID;
    switch (type) {
      case "session.execution.started":
      case "session.step.started":
        this.setLiveState(sessionId, "running");
        break;
      case "session.execution.succeeded":
        this.setLiveState(sessionId, "idle");
        break;
      case "session.execution.interrupted":
        this.setLiveState(sessionId, "interrupted");
        break;
      case "session.execution.failed":
        this.setLiveState(sessionId, "error");
        break;
      case "permission.asked":
        if (sessionId) this.setLiveState(sessionId, "waiting");
        break;
      case "permission.replied":
        // The agent loop resumes after a reply (approve continues the tool,
        // reject fails it) — running until the execution result lands.
        if (sessionId) this.setLiveState(sessionId, "running");
        break;
      default:
        break;
    }
    if (!sessionId) return;
    const listeners = this.sessionListeners.get(sessionId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error("OpenCode Sessions session listener failed:", error);
        }
      }
    }
    if (LIST_REFRESH_EVENTS.has(type)) this.scheduleListRefresh();
  }

  setLiveState(sessionId, status) {
    if (!sessionId) return;
    this.liveStates.set(sessionId, { status, at: Date.now() });
  }

  getLiveState(sessionId) {
    if (!this.serverEvents.connected) return null;
    return this.liveStates.get(sessionId) || { status: "idle", at: 0 };
  }

  async syncActiveSessions() {
    try {
      const response = await this.client.activeSessions();
      const active = new Set(Object.keys(response?.data || {}));
      for (const [sessionId, state] of this.liveStates) {
        if (state.status === "running" && !active.has(sessionId)) {
          this.liveStates.set(sessionId, { status: "idle", at: Date.now() });
        }
      }
      for (const sessionId of active) {
        this.liveStates.set(sessionId, { status: "running", at: Date.now() });
      }
      this.emitChange();
    } catch {
      // discovery failures surface elsewhere
    }
  }

  // (2) Stream lost then recovered: SSE deltas in the gap are unrecoverable,
  // so reconcile every open session against the server + refresh the lists.
  async onStreamReconnected() {
    await this.syncActiveSessions();
    await this.refreshOpenSessions("reconnect");
  }

  openSessionViews() {
    try {
      return this.app.workspace
        .getLeavesOfType(VIEW_TYPE_SESSION)
        .map((leaf) => leaf.view)
        .filter((view) => view instanceof SessionChatView);
    } catch {
      return [];
    }
  }

  async refreshOpenSessions(reason = "") {
    const views = this.openSessionViews();
    if (!views.length) {
      this.emitChange();
      return;
    }
    const force = reason === "reconnect" || reason === "layout-ready" || reason === "manual";
    await Promise.all(
      views.map((view) => {
        if (reason === "reconnect") return view.refreshAfterReconnect().catch(() => {});
        return view.refreshIfStale({ force }).catch(() => {});
      }),
    );
    this.emitChange();
  }

  // Called when the page becomes visible while still connected: refresh
  // tabs that went stale in the background (laptop sleep, throttled tab).
  refreshStaleSessions() {
    for (const view of this.openSessionViews()) {
      view.refreshIfStale().catch(() => {});
    }
  }

  scheduleListRefresh() {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = window.setTimeout(() => {
      this.listRefreshTimer = null;
      this.emitChange();
    }, 400);
  }

  // The OpenCode TUI keeps its default model client-side: the most recently
  // used model (plus its persisted variant) from ~/.local/state/opencode/
  // model.json. The server's /api/model/default only knows the config
  // default, so replicate the TUI resolution order for parity.
  readModelSelectionState() {
    const parsed = readJsonFile(path.join(xdgPath("XDG_STATE_HOME", ".local/state"), "model.json"));
    if (!parsed || !Array.isArray(parsed.recent) || !parsed.recent.length) return null;
    const recent = parsed.recent[0];
    if (!recent || !recent.providerID || !recent.modelID) return null;
    const variants = parsed.variant && typeof parsed.variant === "object" ? parsed.variant : {};
    const variant = variants[`${recent.providerID}/${recent.modelID}`];
    const ref = { id: recent.modelID, providerID: recent.providerID };
    if (variant) ref.variant = String(variant);
    return ref;
  }

  // Default model for a directory, matching OpenCode's own resolution:
  // last-used model (TUI state) → server default for that location.
  async resolveDefaultModel(directory) {
    const fromState = this.readModelSelectionState();
    if (fromState) return fromState;
    try {
      const response = await this.client.defaultModel(directory);
      const model = response?.data;
      if (model?.id && model?.providerID) {
        return { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
      }
    } catch {
      // fall through
    }
    return null;
  }

  restartServerConnection() {
    this.client.invalidate();
    this.serverEvents.reconnectSoon(1);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.emitChange();
  }

  configureRefreshTimer() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    const seconds = Number(this.settings?.refreshSeconds || 0);
    if (seconds > 0) {
      this.refreshTimer = window.setInterval(() => this.refreshConsumers(), seconds * 1000);
    }
  }

  createDashboard(container, options = {}) {
    return new SessionsDashboard(this, container, options);
  }

  async refreshConsumers() {
    // Every mounted dashboard (view + note embeds) listens via subscribe().
    this.emitChange();
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSIONS)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_SESSIONS, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async openSession(sessionId) {
    if (!sessionId) return;
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_SESSION)
      .find((leaf) => leaf.view instanceof SessionChatView && leaf.view.sessionId === sessionId);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      // Previously this just revealed a potentially stale tab (missed SSE
      // while elsewhere). Refresh stale/offline content on pick.
      if (existing.view instanceof SessionChatView) {
        existing.view.refreshIfStale().catch(() => {});
      }
      return existing;
    }
    this.pendingSessionId = sessionId;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_SESSION,
      active: true,
      state: { sessionId },
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  // New-session flow: single configured directory goes straight to a draft
  // chat; several open the directory picker.
  async newSession(options = {}) {
    const { directories } = this.resolveDirectories(options);
    if (!directories.length) {
      new Notice("No directories configured — add them in OpenCode Sessions settings.");
      return;
    }
    if (directories.length === 1) {
      await this.openSessionDraft(directories[0]);
      return;
    }
    await this.activateNewSessionPicker(directories);
  }

  async openSessionDraft(directory) {
    this.pendingDraftDirectory = directory;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_SESSION, active: true, state: { draftDirectory: directory } });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async activateNewSessionPicker(directories) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEW_SESSION)[0];
    if (leaf && leaf.view instanceof NewSessionView) {
      leaf.view.setDirectories(directories);
    } else {
      this.pendingPickerDirectories = directories;
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_NEW_SESSION, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  // ----- SQLite listing (works without the server) ---------------------------

  // Normalizes directory options shared by listing and new-session picking.
  resolveDirectories(options = {}) {
    const requestedDirectories = options.dirs !== undefined
      ? options.dirs
      : options.directories !== undefined
        ? options.directories
        : this.settings.directories;
    // Optional basedir: relative dir entries resolve against it (absolute
    // entries are left untouched) and card labels display relative to it.
    const rawBasedir = String(options.basedir || "").trim();
    // Normalize and drop trailing separators so prefix matching works.
    const basedir = rawBasedir
      ? path.normalize(rawBasedir).replace(/[/\\]+$/, "") || path.sep
      : "";
    const directories = [...new Set((Array.isArray(requestedDirectories) ? requestedDirectories : [requestedDirectories])
      .map((directory) => String(directory || "").trim())
      .filter(Boolean)
      .map((directory) => (basedir && !path.isAbsolute(directory) ? path.join(basedir, directory) : directory))
      .map((directory) => path.normalize(directory)))];
    return { basedir, directories };
  }

  async loadSessions(options = {}) {
    if (!fs.existsSync(this.settings.databasePath)) {
      throw new Error(`Database not found: ${this.settings.databasePath}`);
    }

    const table = "session_v2";
    const { basedir, directories } = this.resolveDirectories(options);
    if (!directories.length) return [];
    const directoryList = directories.map(quoteSql).join(", ");
    const tableExists = await runSqlite(
      this.settings.sqlitePath,
      this.settings.databasePath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${quoteSql(table)}`,
    );
    if (!tableExists.some((row) => row.name === table)) {
      throw new Error(`The v2 table (${table}) was not found in ${this.settings.databasePath}.`);
    }

    const customSql = validateSqlWhereFragment(
      options.customSql !== undefined ? options.customSql : this.settings.customSql,
    );
    const fields = [
      "id",
      "directory",
      "title",
      "model",
      "agent",
      "time_created",
      "time_updated",
      "cost",
      "tokens_input",
      "tokens_output",
      "tokens_reasoning",
      "time_archived",
      "time_suspended",
      "version",
    ].map((field) => `${table}.${field}`).join(", ");

    // SQLite fallback state detection (used when the event stream is down):
    // a running session's latest assistant message has no time.completed.
    const stateFields =
      ", m.time_updated AS last_assistant_time, json_extract(m.data, '$.time.completed') AS last_assistant_completed"
      + ", lm.type AS last_message_type";
    const stateJoin =
      " LEFT JOIN session_message m ON m.session_id = session_v2.id AND m.type = 'assistant'"
      + " AND m.seq = (SELECT MAX(seq) FROM session_message WHERE session_id = session_v2.id AND type = 'assistant')"
      + " LEFT JOIN session_message lm ON lm.session_id = session_v2.id"
      + " AND lm.seq = (SELECT MAX(seq) FROM session_message WHERE session_id = session_v2.id)";

    const clauses = [`directory IN (${directoryList})`];
    if (customSql) clauses.push(`(${customSql})`);
    const rows = (await runSqlite(
      this.settings.sqlitePath,
      this.settings.databasePath,
      `SELECT ${fields}${stateFields} FROM ${table}${stateJoin} WHERE ${clauses.join(" AND ")} ORDER BY ${table}.time_updated DESC`,
    )).map((row) => this.decorateRow({ ...row, source: "opencode2" }, basedir));
    return rows.sort(
      (a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0),
    );
  }

  async loadSessionFromDb(sessionId) {
    if (!fs.existsSync(this.settings.databasePath)) {
      throw new Error(`Database not found: ${this.settings.databasePath}`);
    }
    const rows = await runSqlite(
      this.settings.sqlitePath,
      this.settings.databasePath,
      `SELECT * FROM session_v2 WHERE id = ${quoteSql(sessionId)} LIMIT 1`,
    );
    return rows[0] || null;
  }

  async loadMessagesFromDb(sessionId) {
    if (!fs.existsSync(this.settings.databasePath)) {
      throw new Error(`Database not found: ${this.settings.databasePath}`);
    }
    const rows = await runSqlite(
      this.settings.sqlitePath,
      this.settings.databasePath,
      `SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ${quoteSql(sessionId)} ORDER BY seq ASC`,
    );
    return rows.map((row) => {
      let parsed = {};
      try {
        parsed = JSON.parse(row.data);
      } catch {
        // leave parsed empty
      }
      return {
        ...parsed,
        id: row.id,
        type: row.type,
        time: parsed.time || { created: row.time_created },
      };
    });
  }

  // Rows are decorated once here so every consumer (plugin view, Datacore JSX)
  // gets ready-to-render fields instead of re-implementing formatting.
  // With basedir set, directory labels are shown relative to it.
  decorateRow(row, basedir = "") {
    const state = this.sessionState(row);
    return {
      ...row,
      titleLabel: row.title || "Untitled session",
      state,
      stateLabel: STATE_LABELS[state] || "",
      modelLabel: modelLabel(row.model),
      updatedLabel: formatDate(row.time_updated),
      directoryLabel: displayDirectory(row.directory, basedir || this.vaultRoot),
      tokensLabel: formatTokensFromRow(row),
    };
  }

  sessionState(row) {
    // Live first: the v2 event stream knows the truth (running, idle,
    // interrupted, error, waiting for permission).
    if (this.serverEvents.connected) {
      const live = this.liveStates.get(row.id);
      const status = live ? live.status : "idle";
      if (status === "idle" && row.time_suspended) return "suspended";
      return status;
    }
    // Fallback: infer from the database.
    if (
      row.last_assistant_time &&
      row.last_assistant_completed == null &&
      Date.now() - Number(row.last_assistant_time) < RUNNING_STALE_MS
    ) {
      return "running";
    }
    if (
      row.last_message_type === "user" &&
      Date.now() - Number(row.time_updated) < RUNNING_STALE_MS
    ) {
      return "running";
    }
    if (row.time_suspended) return "suspended";
    return "idle";
  }
};

// Events that should trigger a debounced refresh of the SQLite-backed lists.
const LIST_REFRESH_EVENTS = new Set([
  "session.created",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.renamed",
  "session.usage.updated",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "permission.asked",
  "permission.replied",
  "session.step.started",
  "session.step.ended",
  "session.deleted",
  "session.removed",
]);
