#!/usr/bin/env node
// Dashboard smoke test: runs SessionsDashboard's mount/load/render paths
// against a stubbed DOM + driver, outside Obsidian. Catches "infinite
// Loading…" class regressions (a render() throw aborts mount and freezes
// the status line — exactly what v0.11.0 shipped by accident).
//
// Usage: node scripts/dashboard-smoke.js   (exit 0 = pass)

const fs = require("fs");
const path = require("path");

const mainPath = path.join(__dirname, "..", "main.js");
let src = fs.readFileSync(mainPath, "utf8");
const obsidianLine = src.split("\n").find((l) => l.includes('require("obsidian")'));
if (!obsidianLine) throw new Error("obsidian require not found in main.js");
src = src.replace(
  obsidianLine,
  `const { Plugin = class {}, ItemView = class {}, MarkdownRenderChild = class {}, MarkdownRenderer = class {}, Modal = class {}, Notice = class { constructor(m){this.m=m} }, PluginSettingTab = class {}, Setting = class {}, setIcon = () => {} } = {};`,
);
src += `\nmodule.exports = { SessionsDashboard, SessionNotes };`;

const tmp = path.join(require("os").tmpdir(), "vibed-dashboard-smoke.js");
fs.writeFileSync(tmp, src);
const { SessionsDashboard, SessionNotes } = require(tmp);

function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    value: "",
    title: "",
    disabled: false,
    listeners: {},
    classes: new Set(),
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    createDiv(o = {}) {
      return this.appendChild(makeEl("div", o));
    },
    createEl(t, o = {}) {
      return this.appendChild(makeEl(t, o));
    },
    createSpan(o = {}) {
      return this.appendChild(makeEl("span", o));
    },
    empty() {
      this.children = [];
    },
    remove() {},
    addClass(c) {
      this.classes.add(c);
    },
    removeClass(c) {
      this.classes.delete(c);
    },
    setText(t) {
      this._text = String(t);
    },
    appendText(t) {
      this._text = (this._text || "") + t;
    },
    contains() {
      return false;
    },
  };
  if (opts.text) el._text = String(opts.text);
  return el;
}

const rows = [
  { id: "ses_1", titleLabel: "Fix parser", stateLabel: "Idle", state: "idle", directoryLabel: "proj", directory: "/x/proj", modelLabel: "Sonnet 4.5", model: "anthropic/sonnet-4-5", agent: "build", tokensLabel: "1k", updatedLabel: "now" },
  { id: "ses_2", titleLabel: "Deploy", stateLabel: "Running…", state: "running", directoryLabel: "proj", directory: "/x/proj", modelLabel: "GPT-5", model: "openai/gpt-5", agent: "build", tokensLabel: "2k", updatedLabel: "now" },
];
const driver = {
  capabilities: () => ({ listing: "db", live: "sse", chat: true }),
  streamConnected: () => true,
  listSessions: async () => rows,
  loadSessionRowsByIds: async (ids) => ({ rows: rows.filter((r) => ids.includes(r.id)), missing: [] }),
};
const connector = { id: "c1", name: "opencode", kind: "opencode2", enabled: true };
const plugin = {
  settings: { pageSize: 10, notesDir: "vibed-notes" },
  registry: {
    byName: () => ({ connector, driver }),
    defaultConnector: () => ({ connector, driver }),
  },
  notes: new SessionNotes({
    app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => ({}) } },
    scheduleListRefresh: () => {},
  }),
  subscribe: () => () => {},
  openSession: () => {},
  newSession: () => {},
  openSettings: () => {},
  driverForOptions: () => driver,
  missingSessionRow: (id) => ({ id, titleLabel: id, stateLabel: "", state: "", missing: true }),
};

function findStatus(el) {
  for (const c of el.children) {
    if (c.tagName === "span" && /session/.test(c._text || "")) return c;
    const deep = findStatus(c);
    if (deep) return deep;
  }
  return null;
}

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok — ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL — ${name}\n  ${error.stack.split("\n").slice(0, 3).join("\n  ")}`);
  }
};

(async () => {
  await check("directory dashboard mounts and renders a status line", async () => {
    const container = makeEl("div");
    const dash = new SessionsDashboard(plugin, container, {});
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("load never settled")), 3000));
    await Promise.race([dash.mount(), timeout]);
    const status = (findStatus(container) || {})._text;
    if (!/2 of 2 sessions/.test(status || "")) throw new Error(`unexpected status: ${status}`);
  });

  await check("widget mode (pinned sessions) mounts", async () => {
    const dash = new SessionsDashboard(plugin, makeEl("div"), { sessions: ["ses_1"] });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("load never settled")), 3000));
    await Promise.race([dash.mount(), timeout]);
  });

  await check("filtered render with every criterion set", async () => {
    const dash = new SessionsDashboard(plugin, makeEl("div"), {});
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("load never settled")), 3000));
    await Promise.race([dash.mount(), timeout]);
    dash.filterQuery = { tags: ["x"], states: ["running"], dirs: ["proj"], models: ["sonnet"], phrases: ["fix"] };
    dash.render();
    dash.filterToolsEl = makeEl("div");
    dash.filterMenuEl = dash.filterToolsEl.createDiv();
    dash.renderFilterMenu();
  });

  check("stale filterQuery shape (missing keys) must not crash render", () => {
    const container = makeEl("div");
    const dash = new SessionsDashboard(plugin, container, {});
    dash.sessions = rows;
    dash.listEl = makeEl("div");
    dash.errorEl = makeEl("div");
    dash.moreButton = makeEl("button");
    dash.filterQuery = { tags: [] }; // old shape — regression guard for v0.11.0
    dash.render();
  });

  fs.unlinkSync(tmp);
  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall dashboard smoke checks passed");
})();
