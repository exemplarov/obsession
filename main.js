const { Plugin, ItemView, MarkdownRenderChild, Notice, PluginSettingTab, Setting } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const VIEW_TYPE = "opencode-sessions-view";
const BLOCK_LANGUAGE = "opencode-sessions";
const DEFAULT_REFRESH_SECONDS = 30;
const DEFAULT_PAGE_SIZE = 10;
// A session counts as "running" only if its last assistant message started
// streaming recently; older uncompleted messages are sessions killed mid-reply.
const RUNNING_STALE_MS = 15 * 60 * 1000;
const STATE_LABELS = { running: "Running…", suspended: "Suspended", idle: "Idle", "": "" };

function defaultDatabasePath() {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

function defaultSqlitePath() {
  return process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
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

function formatTokens(row) {
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

// Shared renderer used by both the plugin's own view and
// ```opencode-sessions code blocks embedded in notes. Refreshes are pushed
// by the plugin timer via subscribe(); no per-consumer polling.
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
    // Block-level pageSize wins, then the plugin setting, then the default.
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
    this.statusEl.setText(
      `${filtered.length} of ${this.sessions.length} session${filtered.length === 1 ? "" : "s"}`,
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

  renderCards(sessions) {
    for (const session of sessions) {
      const card = this.listEl.createDiv({
        cls: `opencode-sessions-card opencode-sessions-card-${session.state || "none"}`,
      });
      const head = card.createDiv({ cls: "opencode-sessions-card-head" });
      const title = head.createSpan({
        cls: "opencode-sessions-card-title",
        text: session.titleLabel,
      });
      title.title = `Copy ${session.id}`;
      title.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(session.id);
          new Notice(`Copied ${session.id}`);
        } catch {
          new Notice(session.id);
        }
      });
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
      sub.createSpan({ cls: "opencode-sessions-mono", text: session.id });
      if (session.tokensLabel) sub.appendText(` · ${session.tokensLabel} tokens`);
    }
  }

  renderTable(sessions) {
    const table = this.listEl.createEl("table", { cls: "opencode-sessions-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    ["Title", "State", "Last activity", "Model", "Agent", "Directory", "Tokens", "Kind", "Version", "Session ID"].forEach(
      (label) => headerRow.createEl("th", { text: label }),
    );
    const body = table.createEl("tbody");
    for (const session of sessions) {
      const row = body.createEl("tr");
      const title = row.createEl("td", { cls: "opencode-sessions-title", text: session.titleLabel });
      title.title = `Copy ${session.id}`;
      title.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(session.id);
          new Notice(`Copied ${session.id}`);
        } catch {
          new Notice(session.id);
        }
      });
      row.createEl("td", {
        cls: `opencode-sessions-state opencode-sessions-state-${session.state || "none"}`,
        text: session.stateLabel,
      });
      row.createEl("td", { text: session.updatedLabel });
      row.createEl("td", { text: session.modelLabel });
      row.createEl("td", { text: session.agent || "" });
      row.createEl("td", { text: session.directoryLabel });
      row.createEl("td", { text: session.tokensLabel });
      row.createEl("td", { text: session.source || "" });
      row.createEl("td", { text: session.version || "" });
      row.createEl("td", { text: session.id, cls: "opencode-sessions-id" });
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
    return VIEW_TYPE;
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
class OpenCodeSessionsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OpenCode Sessions" });

    new Setting(containerEl)
      .setName("OpenCode database")
      .setDesc("Read-only SQLite database used by OpenCode.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.databasePath)
          .onChange(async (value) => {
            this.plugin.settings.databasePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Storage backend")
      .setDesc("Select exactly one schema. opencode2 uses session_v2; opencode uses the legacy session table.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("opencode2", "opencode2 (session_v2)")
          .addOption("opencode", "opencode (legacy session)")
          .setValue(this.plugin.settings.databaseKind)
          .onChange(async (value) => {
            this.plugin.settings.databaseKind = value === "opencode" ? "opencode" : "opencode2";
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
      .setDesc("Seconds between automatic refreshes. Use 0 to disable.")
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

module.exports = class OpenCodeSessionsPlugin extends Plugin {
  async onload() {
    this.vaultRoot = this.app.vault.adapter?.basePath || "";
    const saved = (await this.loadData()) || {};
    this.settings = {
      databasePath: saved.databasePath || defaultDatabasePath(),
      sqlitePath: saved.sqlitePath || defaultSqlitePath(),
      databaseKind: saved.databaseKind === "opencode" ? "opencode" : "opencode2",
      directories: Array.isArray(saved.directories) && saved.directories.length
        ? saved.directories
        : [this.vaultRoot].filter(Boolean),
      customSql: typeof saved.customSql === "string" ? saved.customSql : "",
      pageSize: Number.isFinite(saved.pageSize) && saved.pageSize > 0 ? saved.pageSize : DEFAULT_PAGE_SIZE,
      refreshSeconds: Number.isFinite(saved.refreshSeconds)
        ? saved.refreshSeconds
        : DEFAULT_REFRESH_SECONDS,
    };

    this.listeners = new Set();
    this.api = {
      apiVersion: 2,
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
        databaseKind: this.settings.databaseKind,
        directories: [...this.settings.directories],
        customSql: this.settings.customSql,
        refreshSeconds: this.settings.refreshSeconds,
        pageSize: this.settings.pageSize,
      }),
    };
    this.api.getConfig = this.api.config;
    globalThis.opencodeSessions = this.api;

    this.registerView(VIEW_TYPE, (leaf) => new OpenCodeSessionsView(leaf, this));
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
    this.listeners.clear();
    if (globalThis.opencodeSessions === this.api) delete globalThis.opencodeSessions;
  }

  // Push-based change notification: consumers (e.g. Datacore JSX views)
  // subscribe instead of running their own polling timers.
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  async loadSessions(options = {}) {
    if (!fs.existsSync(this.settings.databasePath)) {
      throw new Error(`Database not found: ${this.settings.databasePath}`);
    }

    const databaseKind = options.databaseKind || this.settings.databaseKind;
    const table = databaseKind === "opencode" ? "session" : "session_v2";
    if (databaseKind !== "opencode" && databaseKind !== "opencode2") {
      throw new Error(`Unknown storage backend: ${databaseKind}`);
    }

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
      throw new Error(`The ${databaseKind} table (${table}) was not found in ${this.settings.databasePath}.`);
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

    // opencode2: detect live state from the latest assistant message. It lacks
    // time.completed in its JSON while the reply is still streaming.
    const wantsState = databaseKind === "opencode2";
    const stateFields = wantsState
      ? ", m.time_updated AS last_assistant_time, json_extract(m.data, '$.time.completed') AS last_assistant_completed"
        + ", lm.type AS last_message_type"
      : "";
    const stateJoin = wantsState
      ? " LEFT JOIN session_message m ON m.session_id = session_v2.id AND m.type = 'assistant'"
        + " AND m.seq = (SELECT MAX(seq) FROM session_message WHERE session_id = session_v2.id AND type = 'assistant')"
        + " LEFT JOIN session_message lm ON lm.session_id = session_v2.id"
        + " AND lm.seq = (SELECT MAX(seq) FROM session_message WHERE session_id = session_v2.id)"
      : "";

    const clauses = [`directory IN (${directoryList})`];
    if (customSql) clauses.push(`(${customSql})`);
    const rows = (await runSqlite(
      this.settings.sqlitePath,
      this.settings.databasePath,
      `SELECT ${fields}${stateFields} FROM ${table}${stateJoin} WHERE ${clauses.join(" AND ")} ORDER BY ${table}.time_updated DESC`,
    )).map((row) => this.decorateRow({ ...row, source: databaseKind }, basedir));
    return rows.sort(
      (a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0),
    );
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
      tokensLabel: formatTokens(row),
    };
  }

  sessionState(row) {
    if (row.source !== "opencode2") return "";
    // Streaming: the latest assistant message has no time.completed yet.
    // Note: time_suspended is also stamped on backgrounded/interrupted
    // sessions that keep working, so it must never mask an active session.
    if (
      row.last_assistant_time &&
      row.last_assistant_completed == null &&
      Date.now() - Number(row.last_assistant_time) < RUNNING_STALE_MS
    ) {
      return "running";
    }
    // Question pending: the newest message is still the user's, i.e. a reply
    // is being worked on but no assistant message row exists yet.
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
