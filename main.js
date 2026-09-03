const { Plugin, ItemView, MarkdownRenderChild, MarkdownRenderer, Notice, PluginSettingTab, Setting } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const VIEW_TYPE_SESSIONS = "opencode-sessions-view";
const VIEW_TYPE_SESSION = "opencode-session-view";
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/health`, { headers, signal: controller.signal });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return body && body.healthy ? body : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (endpoint.password) {
        headers.authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${endpoint.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          // ignore
        }
        if (res.status === 401) this.invalidate();
        throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
      }
      if (res.status === 204) return null;
      const contentType = res.headers.get("content-type") || "";
      return contentType.includes("json") ? await res.json() : await res.text();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`timeout: ${method} ${pathname}`);
      }
      this.invalidate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    this.closeSource();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setConnected(false);
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
    const url = `${endpoint.baseUrl}/api/event${endpoint.password ? `?auth_token=${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` : ""}`;
    const source = new EventSource(url);
    this.source = source;
    source.onopen = () => {
      this.attempt = 0;
      this.setConnected(true);
      this.plugin.syncActiveSessions();
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
      this.setConnected(false);
      // CLOSED means the browser gave up (bad URL/auth) — re-discover and
      // reconnect with backoff. CONNECTING means it retries on its own.
      if (source === this.source && source.readyState === EventSource.CLOSED) {
        this.closeSource();
        this.plugin.client.invalidate();
        this.reconnectSoon(Math.min(30000, 1000 * 2 ** Math.min(5, ++this.attempt)));
      }
    };
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.plugin.emitChange();
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
    this.session = null;
    this.offline = false;
    this.busy = false;
    this.liveOutcome = "";
    // messageID -> { el, msg, json, parts: Map(key -> {el, kind, text, ...}) }
    this.messages = new Map();
    this.order = [];
    this.cursorPrevious = null;
    this.loadingOlder = false;
    this.unsubscribed = false;
    this.reconcileTimer = null;
    this.loadSeq = 0;
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

  setSession(sessionId) {
    this.sessionId = sessionId;
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("opencode-session-view");
    if (!this.sessionId) {
      this.contentEl.createDiv({ cls: "opencode-session-empty", text: "No session selected." });
      return;
    }
    this.buildSkeleton();
    this.unsubscribeEvents = this.plugin.subscribeSession(this.sessionId, (event) =>
      this.onServerEvent(event),
    );
    this.unsubscribeStream = this.plugin.subscribe(() => this.updateComposer());
    await this.loadInitial();
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
    this.hintEl.setText(
      this.offline
        ? "Offline — input disabled"
        : this.busy
          ? "Streaming… new messages attach at the bottom; Stop interrupts"
          : connected
            ? "Live — connected to the OpenCode v2 event stream"
            : "Reconnecting…",
    );
  }

  setBusy(busy, outcome = "") {
    this.busy = busy;
    this.liveOutcome = outcome;
    this.renderBadge();
    this.updateComposer();
  }

  renderBadge() {
    const live = this.plugin.getLiveState(this.sessionId);
    const state = this.busy ? "running" : live && live.status !== "running" ? live.status : "idle";
    this.badgeEl.className = `opencode-sessions-badge opencode-sessions-badge-${state}`;
    this.badgeEl.setText(STATE_LABELS[state] || "");
  }

  renderHeader() {
    if (!this.session) return;
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
        this.plugin.client.messages(this.sessionId, { limit: DEFAULT_MESSAGE_PAGE, order: "asc" }),
      ]);
      if (this.unsubscribed || seq !== this.loadSeq) return;
      this.setOffline(false);
      this.session = sessionResponse?.data || null;
      this.resetMessages();
      this.appendMessages(messagesResponse?.data || [], messagesResponse?.cursor?.previous || null);
      // If the session is already running (view opened mid-stream), adopt it.
      const live = this.plugin.getLiveState(this.sessionId);
      this.setBusy(live?.status === "running" || live?.status === "waiting");
      this.renderHeader();
      this.renderBadge();
    } catch (error) {
      if (this.unsubscribed || seq !== this.loadSeq) return;
      this.setOffline(true, error.message);
      await this.loadFromDb();
    }
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
    this.olderButton.style.display = "none";
  }

  appendMessages(list, cursorPrevious) {
    for (const message of list || []) {
      this.upsertMessage(message);
    }
    if (cursorPrevious !== null && cursorPrevious !== undefined) {
      this.cursorPrevious = cursorPrevious;
    }
    this.olderButton.style.display = this.cursorPrevious ? "" : "none";
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
        // The session pauses until the permission is answered elsewhere.
        this.renderBadge();
        this.hintEl.setText("Waiting for permission approval…");
        break;
      default:
        break;
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
    this.reconcileTimer = window.setTimeout(async () => {
      this.reconcileTimer = null;
      if (this.unsubscribed || this.offline) return;
      try {
        const limit = Math.max(DEFAULT_MESSAGE_PAGE, this.messages.size);
        const response = await this.plugin.client.messages(this.sessionId, { limit, order: "asc" });
        if (this.unsubscribed) return;
        const previousFirst = this.order[0];
        for (const message of response?.data || []) {
          this.upsertMessage(message);
        }
        if (previousFirst) {
          // New messages may have arrived on top; nothing else to do —
          // upsertMessage prepends unknown ids at the bottom.
        }
        const sessionResponse = await this.plugin.client.session(this.sessionId).catch(() => null);
        if (!this.unsubscribed && sessionResponse?.data) {
          this.session = sessionResponse.data;
          this.renderHeader();
        }
      } catch {
        // ignore — the next event or manual refresh will retry
      }
    }, 700);
  }

  async loadOlder() {
    if (this.loadingOlder || !this.cursorPrevious || this.offline) return;
    this.loadingOlder = true;
    this.olderButton.setText("Loading…");
    const chat = this.chatEl;
    const beforeHeight = chat.scrollHeight;
    const beforeTop = chat.scrollTop;
    try {
      const response = await this.plugin.client.messages(this.sessionId, {
        order: "asc",
        cursor: this.cursorPrevious,
      });
      const list = response?.data || [];
      this.cursorPrevious = response?.cursor?.previous || null;
      // Older messages belong at the visual top = END of the DOM (the chat
      // is column-reverse), inserted newest-of-batch first so the final DOM
      // order stays chronological.
      for (const message of [...list].reverse()) {
        if (this.messages.has(message.id)) continue;
        const el = this.renderOlderMessageEl(message);
        chat.insertBefore(el, this.olderButton);
      }
      // Keep the viewport on the same content: content was added above.
      chat.scrollTop = beforeTop - (chat.scrollHeight - beforeHeight);
    } catch (error) {
      new Notice(`Could not load older messages: ${error.message}`);
    } finally {
      this.loadingOlder = false;
      this.olderButton.setText("Load older messages");
      this.olderButton.style.display = this.cursorPrevious ? "" : "none";
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

  async stop() {
    if (this.offline) return;
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
    this.addRibbonIcon("messages-square", "Open OpenCode sessions", () => this.activateView());
    this.addSettingTab(new OpenCodeSessionsSettingTab(this.app, this));
    this.configureRefreshTimer();
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

  scheduleListRefresh() {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = window.setTimeout(() => {
      this.listRefreshTimer = null;
      this.emitChange();
    }, 400);
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
      return existing;
    }
    this.pendingSessionId = sessionId;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_SESSION, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  // ----- SQLite listing (works without the server) ---------------------------

  async loadSessions(options = {}) {
    if (!fs.existsSync(this.settings.databasePath)) {
      throw new Error(`Database not found: ${this.settings.databasePath}`);
    }

    const table = "session_v2";
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
  "session.step.started",
  "session.step.ended",
  "session.deleted",
  "session.removed",
]);
