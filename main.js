const { Plugin, ItemView, MarkdownRenderChild, MarkdownRenderer, Modal, Notice, PluginSettingTab, Setting, setIcon } = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

const VIEW_TYPE_SESSIONS = "opencode-sessions-view";
const VIEW_TYPE_SESSION = "opencode-session-view";
const VIEW_TYPE_NEW_SESSION = "opencode-new-session-view";
const BLOCK_LANGUAGE = "vibed";
const DEFAULT_REFRESH_SECONDS = 30;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE = 100;
const DEFAULT_NOTES_DIR = "vibed-notes";
// Notes autosave debounce: typing pauses of less than this don't hit the disk.
const NOTES_SAVE_DEBOUNCE_MS = 600;
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
  question: "Needs answer",
  interrupted: "Interrupted",
  error: "Error",
  "": "",
};

// ---------------------------------------------------------------------------
// Connectors. A connector is one named instance of a backend — the local
// OpenCode v2 install (default, zero-config), a remote v2 server, or (later)
// local transcript backends like Claude Code / Codex / Cursor. Connectors are
// named (unique, editable); widgets and links reference them by name.
// ---------------------------------------------------------------------------

const CONNECTOR_KINDS = {
  opencode2: {
    id: "opencode2",
    label: "OpenCode v2",
    baseName: "opencode",
    createConfig: () => ({
      apiBaseUrl: "",
      apiPassword: "",
      useDatabase: true,
      databasePath: defaultDatabasePath(),
      sqlitePath: defaultSqlitePath(),
      directories: [],
      customSql: "",
    }),
  },
  opencode1: {
    id: "opencode1",
    label: "OpenCode v1",
    baseName: "opencode-v1",
    createConfig: () => ({
      databasePath: defaultDatabasePath(),
      sqlitePath: defaultSqlitePath(),
      directories: [],
      customSql: "",
    }),
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    baseName: "claude",
    createConfig: () => ({
      projectsRoot: path.join(os.homedir(), ".claude", "projects"),
      directories: [],
    }),
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    baseName: "codex",
    createConfig: () => ({
      sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
      zstdPath: "zstd",
      directories: [],
    }),
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    baseName: "cursor",
    createConfig: () => ({
      projectsRoot: path.join(os.homedir(), ".cursor", "projects"),
      directories: [],
    }),
  },
};

function newConnectorId() {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `c-${Date.now().toString(36)}-${random}`;
}

// Names are the user-facing handle for a connector (widgets, links, chat
// refs), so they must be unique and cannot contain the ref separator ":".
function isValidConnectorName(name) {
  return typeof name === "string" && name.trim().length > 0 && !name.includes(":");
}

// Suggested name for a new connector of a kind: the kind's base name
// ("opencode", "codex", …), then base-2, base-3, … skipping taken names.
function generateConnectorName(kindId, takenNames) {
  const taken = new Set(takenNames);
  const base = CONNECTOR_KINDS[kindId]?.baseName || kindId;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Normalizes a persisted connector entry: fills kind defaults, guards types.
function normalizeConnector(entry) {
  const kind = CONNECTOR_KINDS[entry?.kind] ? entry.kind : "opencode2";
  const config = {
    ...CONNECTOR_KINDS[kind].createConfig(),
    ...(entry?.config && typeof entry.config === "object" ? entry.config : {}),
  };
  config.directories = Array.isArray(config.directories)
    ? config.directories.map((directory) => String(directory || "").trim()).filter(Boolean)
    : [];
  const rawName = typeof entry?.name === "string" ? entry.name.trim() : "";
  // Names containing ":" would break the "name:sessionId" ref syntax; a
  // hand-edited data.json with such a name falls back to the kind's base
  // name (dedupe uniquifies it below).
  const name = rawName && !rawName.includes(":") ? rawName : CONNECTOR_KINDS[kind].baseName;
  return {
    id: typeof entry?.id === "string" && entry.id ? entry.id : newConnectorId(),
    kind,
    name,
    enabled: entry?.enabled !== false,
    config,
  };
}

function dedupeConnectorNames(connectors) {
  const seen = new Set();
  for (const connector of connectors) {
    if (!seen.has(connector.name)) {
      seen.add(connector.name);
      continue;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${connector.name}-${n}`;
      if (!seen.has(candidate)) {
        connector.name = candidate;
        seen.add(candidate);
        break;
      }
    }
  }
}

// Settings schema v2 (named connectors). A store without a `connectors`
// array is a fresh install: create the zero-config local OpenCode v2
// connector, scoped to the vault (listing needs a directory scope).
// Vault folder for session notes, as a vault-relative path ("vibed-notes").
// Empty input restores the default; absolute prefixes and trailing slashes
// are stripped so the value is always a clean relative folder.
function normalizeNotesDir(value) {
  const cleaned = String(value || "")
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+$/, "")
    .trim();
  return cleaned || DEFAULT_NOTES_DIR;
}

function normalizeSettings(saved, vaultRoot) {
  const pageSize =
    Number.isFinite(saved.pageSize) && saved.pageSize > 0 ? saved.pageSize : DEFAULT_PAGE_SIZE;
  const refreshSeconds = Number.isFinite(saved.refreshSeconds)
    ? saved.refreshSeconds
    : DEFAULT_REFRESH_SECONDS;
  const notesDir =
    typeof saved.notesDir === "string" ? normalizeNotesDir(saved.notesDir) : DEFAULT_NOTES_DIR;
  let connectors = Array.isArray(saved.connectors) ? saved.connectors.map(normalizeConnector) : null;
  if (!connectors) {
    const config = CONNECTOR_KINDS.opencode2.createConfig();
    if (vaultRoot) config.directories = [vaultRoot];
    connectors = [
      normalizeConnector({
        id: newConnectorId(),
        kind: "opencode2",
        name: CONNECTOR_KINDS.opencode2.baseName,
        enabled: true,
        config,
      }),
    ];
  }
  dedupeConnectorNames(connectors);
  return {
    schemaVersion: 2,
    defaultConnectorId: connectors.some((c) => c.id === saved.defaultConnectorId)
      ? saved.defaultConnectorId
      : connectors[0]?.id || "",
    pageSize,
    refreshSeconds,
    notesDir,
    connectors,
  };
}

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

// ---------------------------------------------------------------------------
// File-backend helpers. Claude Code / Codex / Cursor persist sessions as
// JSONL under a home-directory root; listing scans cheaply (head+tail of
// each file) and chats fully parse (cached by mtime/size).
// ---------------------------------------------------------------------------

// Claude/Cursor encode the project cwd by replacing non-alphanumerics with
// "-", which is lossy ("my-project" and "my/project" collide). Decoding
// prefers an exact match against the user's configured directories and
// falls back to a naive dash→separator guess for display.
// Claude keeps the leading dash ("-Users-roman-…") while Cursor drops it
// ("Users-roman-…"), so slugs compare with edge hyphens trimmed — one slug
// table matches both backends' encodings.
function slugifyPath(directory) {
  return String(directory || "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Session-note helpers. Notes are ordinary vault markdown files attached to
// a session via a `session:` frontmatter key — never via the filename — so
// they survive renames and moves anywhere in the vault.
// ---------------------------------------------------------------------------

// Obsidian forbids these in filenames (and #^[] break wikilinks even when
// the filesystem allows them).
function sanitizeNoteName(title) {
  const cleaned = String(title || "")
    .replace(/["*\\/:<>?|#^[\]\x00-\x1f]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .slice(0, 80);
  return cleaned || "untitled";
}

// Splits a note into its raw frontmatter block (between the --- markers) and
// the body. Files without frontmatter return null — the caller only ever
// rewrites files it found through the frontmatter index, so this is just a
// corruption guard.
function splitNoteFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text || ""));
  if (!match) return null;
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function buildNoteContent(fields) {
  // JSON.stringify doubles as YAML double-quoting for free-form values
  // (names/titles may contain ":" or "#", which would break bare YAML).
  const lines = [
    "---",
    `session: ${JSON.stringify(String(fields.sessionId))}`,
    `connector: ${JSON.stringify(String(fields.connectorName || ""))}`,
    `title: ${JSON.stringify(String(fields.title || ""))}`,
    `created: ${new Date().toISOString()}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function trimSlugEdges(value) {
  return String(value || "").replace(/^-+|-+$/g, "");
}

function decodeEncodedDir(encoded, configuredDirs = []) {
  for (const directory of configuredDirs) {
    if (slugifyPath(directory) === trimSlugEdges(encoded)) return directory;
  }
  const decoded = `/${String(encoded || "")
    .replace(/^-+/, "")
    .split("-")
    .filter(Boolean)
    .join("/")}`;
  return decoded;
}

// Encoded dirs (Claude/Cursor) match filter entries by slug — the encoded
// form is lossless, unlike decoded paths where "forty-two" naively decodes
// to "forty/two". Real-cwd backends (Codex) match by path.
function directoryMatchesFilter(entry, wantedPaths, wantedSlugs) {
  if (!wantedPaths.size) return true;
  if (entry.encodedDir) return wantedSlugs.has(trimSlugEdges(entry.encodedDir));
  return wantedPaths.has(path.normalize(entry.directory || ""));
}

// Best display directory: the exact configured path whose slug matches the
// encoded dir, else the decoded fallback.
function displayDirectoryFor(entry, wantedPaths) {
  if (entry.encodedDir) {
    for (const wanted of wantedPaths) {
      if (slugifyPath(wanted) === trimSlugEdges(entry.encodedDir)) return wanted;
    }
  }
  return entry.directory;
}

// Reads the first `headBytes` and last `tailBytes` of a file without loading
// the middle — listing scans stay fast even on multi-MB transcripts.
function readHeadTail(filePath, headBytes = 64 * 1024, tailBytes = 256 * 1024) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const fd = fs.openSync(filePath, "r");
  try {
    const read = (start, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      if (buffer.length <= 0) return "";
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    };
    const head = read(0, headBytes);
    const tail = size > headBytes ? read(Math.max(0, size - tailBytes), tailBytes) : "";
    return { head, tail, stat };
  } finally {
    fs.closeSync(fd);
  }
}

// Iterates JSONL lines of a text block; malformed lines are skipped (files
// can be truncated mid-write by a running CLI).
function eachJsonLine(text, visit) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") visit(parsed);
  }
}

function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Session titles derived from the first user prompt (Codex/Cursor).
// Wrapped prompts (<user_query>…</user_query>, Cursor style) are unwrapped
// before display/title derivation.
function extractPromptText(text) {
  const raw = String(text || "");
  const match = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return match ? match[1].trim() : raw;
}

function deriveTitle(text) {
  const flat = extractPromptText(text)
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

// Codex injects environment context as user-role messages (AGENTS.md,
// permissions, plugin lists — wrapped in XML-ish tags or markdown headers);
// real prompts read as plain prose.
function looksLikeInjectedContext(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  return raw.startsWith("<") || raw.startsWith("# ");
}

// rollout-YYYY-MM-DDTHH-MM-SS-… → epoch ms (time dashes are colons).
function codexFilenameTime(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)$/.exec(String(value || ""));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function runExternal(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// GUI-launched Obsidian often lacks Homebrew's bin dir on PATH; probe the
// usual suspects for the zstd executable once and remember what worked
// (existing absolute paths win over a bare PATH lookup).
let zstdExecutableCache = null;
function resolveZstdExecutable(configured) {
  if (configured && configured !== "zstd") return configured;
  if (zstdExecutableCache !== null) return zstdExecutableCache;
  const candidates = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "zstd"];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        zstdExecutableCache = candidate;
        return candidate;
      } catch {
        continue;
      }
    }
  }
  zstdExecutableCache = "zstd"; // bare name: let PATH decide at spawn
  return "zstd";
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

// Parses ```vibed block config: a JSON object, or simple
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
  // `connector` is the shared mutable connector entry ({ id, kind, name,
  // enabled, config }) — URL/password config edits apply without recreating
  // the client.
  constructor(connector) {
    this.connector = connector;
    this.endpoint = null;
    this.endpointAt = 0;
    this.healthInfo = null;
  }

  invalidate() {
    this.endpoint = null;
    this.endpointAt = 0;
    // The form/question protocol is a property of the *server*; a repointed
    // URL or an in-place server upgrade can flip it — re-probe after reset.
    this.questionProtocol = undefined;
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
    const settings = this.connector.config;
    const overrideUrl = String(settings.apiBaseUrl || "").trim().replace(/\/+$/, "");
    const overridePassword = String(settings.apiPassword || "").trim();
    const candidates = [];
    if (overrideUrl) {
      // An explicit URL is authoritative: no silent fallback to a local
      // server when the remote one is unreachable (multi-connector setups
      // would otherwise collapse two connectors onto one server).
      candidates.push({ baseUrl: overrideUrl, password: overridePassword, override: true });
    } else {
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
    }
    for (const candidate of candidates) {
      const health = await OpenCodeClient.probe(candidate.baseUrl, candidate.password);
      if (health) {
        this.endpoint = candidate;
        this.endpointAt = Date.now();
        this.healthInfo = health;
        return candidate;
      }
    }
    throw new Error(
      overrideUrl
        ? `OpenCode v2 server not reachable at ${overrideUrl}`
        : "OpenCode v2 server not found (no /api/health responded)",
    );
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

  // Full session list (used when the local database is unavailable — e.g.
  // remote servers). Each item: id, title, agent, model, cost, tokens,
  // time{created,updated,…}, location{directory}.
  listSessions() {
    return this.request("/api/session", { timeoutMs: 20000 });
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

  agents(directory) {
    return this.request(`/api/agent${this.locationQuery(directory)}`);
  }

  setSessionAgent(sessionId, agent) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
      method: "POST",
      body: { agent },
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

  // ----- agent questions (the `question` tool) -------------------------------
  //
  // Two server generations expose these differently; both are normalized:
  //  - "form": GET /api/session/:id/form + reply/cancel — the question tool
  //    surfaces as a form with fields q0, q1, … (answers keyed by field)
  //  - "question": GET /api/session/:id/question + reply/reject — newer v2
  //    servers (answers ordered per question, each an array of labels)
  // The available protocol is probed once per server and cached.

  sessionForms(sessionId) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/form`);
  }

  replyForm(sessionId, formId, answer) {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { method: "POST", body: { answer } },
    );
  }

  cancelForm(sessionId, formId) {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/cancel`,
      { method: "POST" },
    );
  }

  sessionQuestions(sessionId) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/question`);
  }

  replyQuestionRequest(sessionId, requestId, answers) {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: { answers } },
    );
  }

  rejectQuestionRequest(sessionId, requestId) {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
      { method: "POST" },
    );
  }

  // Pending question batches normalized to one shape:
  // { protocol, id, sessionID, title, questions: [{ key, header, question,
  //   multiple, boolean, numeric, external, custom,
  //   options: [{ label, value, description }] }] }
  async pendingQuestions(sessionId) {
    if (this.questionProtocol === "question") {
      return this.normalizeQuestionRequests(await this.sessionQuestions(sessionId));
    }
    if (this.questionProtocol === "form") {
      return this.normalizeForms(await this.sessionForms(sessionId));
    }
    if (this.questionProtocol === "unsupported") return [];
    try {
      const forms = await this.sessionForms(sessionId);
      this.questionProtocol = "form";
      return this.normalizeForms(forms);
    } catch (error) {
      if (!String(error.message).startsWith("404")) throw error;
      try {
        const questions = await this.sessionQuestions(sessionId);
        this.questionProtocol = "question";
        return this.normalizeQuestionRequests(questions);
      } catch (questionError) {
        if (!String(questionError.message).startsWith("404")) throw questionError;
        // Neither endpoint exists (older v2 build) — negative-cache instead
        // of double-probing on every refresh.
        this.questionProtocol = "unsupported";
        return [];
      }
    }
  }

  normalizeForms(response) {
    return (response?.data || []).filter(Boolean).map((form) => ({
      protocol: "form",
      id: form.id,
      sessionID: form.sessionID || "",
      title: form.title || "Questions",
      questions: (form.fields || []).map((field) => ({
        key: field.key,
        header: field.title || field.key,
        question: field.description || "",
        multiple: field.type === "multiselect",
        boolean: field.type === "boolean",
        numeric: field.type === "number" || field.type === "integer",
        external: field.type === "external",
        custom: field.custom !== false,
        options: (field.options || []).map((option) => ({
          label: option.label ?? option.value,
          value: option.value ?? option.label,
          description: option.description || "",
        })),
      })),
    }));
  }

  normalizeQuestionRequests(response) {
    return (response?.data || []).filter(Boolean).map((request) => ({
      protocol: "question",
      id: request.id,
      sessionID: request.sessionID || "",
      title: "Questions",
      questions: (request.questions || []).map((question, index) => ({
        key: `q${index}`,
        header: question.header || `Question ${index + 1}`,
        question: question.question || "",
        multiple: question.multiple === true,
        boolean: false,
        numeric: false,
        external: false,
        custom: question.custom !== false,
        options: (question.options || []).map((option) => ({
          label: option.label,
          value: option.label,
          description: option.description || "",
        })),
      })),
    }));
  }

  // Submits normalized answers (question key -> option value(s), custom text,
  // boolean, or number) using the protocol the request was loaded with.
  async replyPendingQuestions(sessionId, pending, answers) {
    if (pending.protocol === "question") {
      const ordered = pending.questions.map((question) => {
        const value = answers.get(question.key);
        if (Array.isArray(value)) return value;
        return value === undefined || value === "" ? [] : [value];
      });
      return this.replyQuestionRequest(sessionId, pending.id, ordered);
    }
    const answer = {};
    for (const question of pending.questions) {
      // External fields are an acknowledgement (OAuth/integration flows):
      // the server requires the literal `true` on reply — Submit grants it.
      answer[question.key] = question.external ? true : answers.get(question.key);
    }
    return this.replyForm(sessionId, pending.id, answer);
  }

  // Rejects a pending batch: the tool call fails and the session continues.
  async dismissPendingQuestions(sessionId, pending) {
    return pending.protocol === "question"
      ? this.rejectQuestionRequest(sessionId, pending.id)
      : this.cancelForm(sessionId, pending.id);
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
  // One stream per OpenCode v2 driver: `driver` supplies the client
  // (endpoint/auth) and identifies the connector when events fan out.
  constructor(plugin, driver) {
    this.plugin = plugin;
    this.driver = driver;
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
      endpoint = await (this.connecting = this.driver.client.resolve(this.attempt > 0));
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
      if (event && event.type) this.plugin.handleServerEvent(event, this.driver);
    };
    source.onerror = () => {
      // NodeSSE closes itself before reporting; re-discover and retry with
      // backoff (idle watchdog, stream end, socket error, bad status).
      if (source !== this.source) return;
      this.closeSource();
      this.setConnected(false);
      this.driver.client.invalidate();
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
        this.plugin.onStreamReconnected(this.driver);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Connector drivers. A driver owns one connector instance: transport, live
// event stream, and data access. Drivers normalize data into the shared
// session/message model; every method may throw, and callers scope failures
// to the connector that produced them.
// ---------------------------------------------------------------------------

class ConnectorDriver {
  constructor(plugin, connector) {
    this.plugin = plugin;
    // Shared mutable settings object ({ id, kind, name, enabled, config });
    // edits in the settings tab apply without recreating the driver.
    this.connector = connector;
  }

  get config() {
    return this.connector.config || {};
  }

  capabilities() {
    throw new Error(`${this.constructor.name} must implement capabilities()`);
  }

  async health() {
    return { ok: false, detail: "unknown connector kind" };
  }

  // Live-connection indicator for status lines and dashboards.
  streamConnected() {
    return false;
  }

  getLiveState() {
    return null;
  }

  dispose() {}

  // Enabled/disabled transitions from the settings tab.
  setActive(active) {
    if (active) this.start();
    else this.stop();
  }

  start() {}

  stop() {}
}

class OpenCode2Driver extends ConnectorDriver {
  constructor(plugin, connector) {
    super(plugin, connector);
    this.client = new OpenCodeClient(connector);
    // sessionID -> { status, at } live states from this server's stream.
    this.liveStates = new Map();
    this.stream = new ServerEventStream(plugin, this);
  }

  start() {
    this.stream.start();
  }

  stop() {
    this.stream.stop();
  }

  dispose() {
    this.stop();
    this.liveStates.clear();
  }

  restartConnection() {
    this.client.invalidate();
    this.stream.reconnectSoon(1);
  }

  streamConnected() {
    return this.stream.connected;
  }

  getLiveState(sessionId) {
    if (!this.stream.connected) return null;
    return this.liveStates.get(sessionId) || { status: "idle", at: 0 };
  }

  capabilities() {
    return {
      listing: this.databaseUsable() ? "db" : "api",
      live: "sse",
      messages: true,
      pagination: true,
      chat: true,
      models: true,
      agents: true,
      permissions: true,
      questions: true,
      drafts: true,
      tokens: true,
      cost: true,
      titles: "stored",
    };
  }

  async health() {
    const health = await this.client.health();
    return { ok: true, detail: `OpenCode v${health.version} (pid ${health.pid})` };
  }

  // ----- live event handling (v2) --------------------------------------------

  onServerDisposed() {
    this.client.invalidate();
    this.liveStates.clear();
    this.stream.reconnectSoon(1000);
  }

  applyLiveEvent(type, sessionId) {
    if (!sessionId) return;
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
      case "permission.v2.asked": // next-gen servers renamed the event
        this.setLiveState(sessionId, "waiting");
        break;
      case "form.created":
      case "question.v2.asked":
        this.setLiveState(sessionId, "question");
        break;
      case "permission.replied":
      case "permission.v2.replied":
      case "form.replied":
      case "form.cancelled":
      case "question.v2.replied":
      case "question.v2.rejected":
        // The agent loop resumes after a reply (answers continue the tool,
        // rejection fails it) — running until the execution result lands.
        this.setLiveState(sessionId, "running");
        break;
      default:
        break;
    }
  }

  setLiveState(sessionId, status) {
    if (!sessionId) return;
    this.liveStates.set(sessionId, { status, at: Date.now() });
  }

  // A poll proved this status is gone (e.g. the question was answered from
  // another surface while the event stream was down) — demote it to idle so
  // dashboards and badges don't read "Needs answer"/"Needs approval" forever.
  clearLiveStatus(sessionId, status) {
    if (!sessionId) return;
    const state = this.liveStates.get(sessionId);
    if (!state || state.status !== status) return;
    this.liveStates.set(sessionId, { status: "idle", at: Date.now() });
    this.plugin.emitChange();
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
      this.plugin.emitChange();
    } catch {
      // discovery failures surface elsewhere
    }
  }

  // ----- listing ---------------------------------------------------------------

  // DB listing when enabled and present; API listing otherwise (remote
  // servers, or the database file moved away).
  databaseUsable() {
    return !!this.config.useDatabase && fs.existsSync(this.config.databasePath);
  }

  async listSessions(options = {}) {
    if (this.databaseUsable()) return this.listSessionsFromDb(options);
    return this.listSessionsFromApi(options);
  }

  async listSessionsFromApi(options = {}) {
    const { basedir, directories } = this.plugin.resolveDirectories(options, this.connector);
    const response = await this.client.listSessions();
    const list = Array.isArray(response?.data) ? response.data : [];
    const wanted = new Set(directories.map((directory) => path.normalize(directory)));
    const rows = list
      .filter((session) => {
        // Explicit id lookups bypass the directory filter entirely.
        if (options.allDirectories) return true;
        // Parity with the DB path: no configured directories → no rows.
        if (!wanted.size) return false;
        const directory = session?.location?.directory || "";
        return wanted.has(path.normalize(directory));
      })
      .map((session) => this.apiSessionRow(session, basedir));
    return rows.sort((a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0));
  }

  // Maps a /api/session item onto the decorated row shape the dashboards
  // consume (same fields as the session_v2 SQL rows).
  apiSessionRow(session, basedir) {
    const tokens = session.tokens && typeof session.tokens === "object" ? session.tokens : {};
    return this.plugin.decorateRow(
      {
        id: session.id,
        directory: session.location?.directory || "",
        title: session.title || null,
        agent: session.agent || "",
        model: session.model || null,
        time_created: session.time?.created || null,
        time_updated: session.time?.updated || null,
        time_archived: null,
        time_suspended: null,
        version: null,
        cost: session.cost || 0,
        tokens_input: tokens.input || 0,
        tokens_output: tokens.output || 0,
        tokens_reasoning: tokens.reasoning || 0,
        // API rows carry no fallback-state hints; the event stream (or idle)
        // decides. Note: this beta API exposes time.idle but NOT the
        // suspend timestamp, so API rows never report "Suspended".
        last_assistant_time: null,
        last_assistant_completed: null,
        last_message_type: null,
        connectorId: this.connector.id,
        connectorName: this.connector.name,
        source: "opencode2",
      },
      basedir,
    );
  }

  async listSessionsFromDb(options = {}) {
    const settings = this.config;
    const table = "session_v2";
    const { basedir, directories } = this.plugin.resolveDirectories(options, this.connector);
    if (!directories.length) return [];
    const directoryList = directories.map(quoteSql).join(", ");
    const tableExists = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${quoteSql(table)}`,
    );
    if (!tableExists.some((row) => row.name === table)) {
      throw new Error(`The v2 table (${table}) was not found in ${settings.databasePath}.`);
    }

    const customSql = validateSqlWhereFragment(
      options.customSql !== undefined ? options.customSql : settings.customSql,
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
      settings.sqlitePath,
      settings.databasePath,
      `SELECT ${fields}${stateFields} FROM ${table}${stateJoin} WHERE ${clauses.join(" AND ")} ORDER BY ${table}.time_updated DESC`,
    )).map((row) =>
      this.plugin.decorateRow(
        {
          ...row,
          connectorId: this.connector.id,
          connectorName: this.connector.name,
          source: "opencode2",
        },
        basedir,
      ),
    );
    return rows.sort(
      (a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0),
    );
  }

  // ----- conversation access (shared shape with file drivers) -----------------

  // Both return the unwrapped shapes chat views consume: getSession → the
  // session object, listMessages → { data, cursor: { next } } with pages
  // newest-first (order=desc) or by cursor.
  async getSession(sessionId) {
    const response = await this.client.session(sessionId);
    return response?.data || null;
  }

  async listMessages(sessionId, options = {}) {
    return this.client.messages(sessionId, options);
  }

  async loadSessionFromDb(sessionId) {
    const settings = this.config;
    if (!fs.existsSync(settings.databasePath)) {
      throw new Error(`Database not found: ${settings.databasePath}`);
    }
    const rows = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      `SELECT * FROM session_v2 WHERE id = ${quoteSql(sessionId)} LIMIT 1`,
    );
    return rows[0] || null;
  }

  // Rows for explicitly pinned session ids (widget mode); preserves the
  // given order and reports ids that no longer exist. Falls back to the
  // API list when the database is unavailable.
  async loadSessionRowsByIds(ids) {
    if (!this.databaseUsable()) {
      // Explicit ids bypass the directory filter; errors propagate so the
      // dashboard can distinguish "unreachable" from "deleted".
      const rows = await this.listSessionsFromApi({ allDirectories: true });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return {
        rows: ids.map((id) => byId.get(id)).filter(Boolean),
        missing: ids.filter((id) => !byId.has(id)),
      };
    }
    const rows = [];
    const missing = [];
    for (const id of ids) {
      try {
        const row = await this.loadSessionFromDb(id);
        if (row) {
          rows.push(
            this.plugin.decorateRow(
              {
                ...row,
                connectorId: this.connector.id,
                connectorName: this.connector.name,
                source: "opencode2",
              },
              "",
            ),
          );
        } else {
          missing.push(id);
        }
      } catch {
        missing.push(id);
      }
    }
    return { rows, missing };
  }

  async loadMessagesFromDb(sessionId) {
    const settings = this.config;
    if (!fs.existsSync(settings.databasePath)) {
      throw new Error(`Database not found: ${settings.databasePath}`);
    }
    const rows = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
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
}

// ---------------------------------------------------------------------------
// File-based read-only connectors (Claude Code, Codex CLI, Cursor Agent).
// Sessions live as JSONL transcripts under a home-directory root. Listing
// head/tail-scans each file; chats fully parse with an mtime/size cache.
// Liveness is a freshness heuristic (no SSE): recently-touched transcripts
// whose last line suggests an open turn render as Running.
// ---------------------------------------------------------------------------

class FileConnectorDriver extends ConnectorDriver {
  constructor(plugin, connector) {
    super(plugin, connector);
    // sessionId -> { mtimeMs, size, session, messages } full-parse cache
    // (LRU-bounded: giant transcripts must not accumulate in the heap).
    this.parseCache = new Map();
    this.parseInflight = new Map();
    // sessionId -> last scanned state ("running" | "idle").
    this.sessionStates = new Map();
  }

  // Parsed transcripts can reach hundreds of MB (cold-storage rollouts);
  // larger files are refused with a clear message instead of stalling the
  // renderer, and tool outputs are truncated for display.
  static MAX_PARSE_BYTES = 128 * 1024 * 1024;
  static MAX_TOOL_OUTPUT_CHARS = 200 * 1024;
  static PARSE_CACHE_LIMIT = 6;

  capabilities() {
    return {
      listing: "files",
      live: "poll",
      messages: true,
      pagination: true, // in-memory (synthetic offset cursors)
      chat: false,
      models: false,
      agents: false,
      permissions: false,
      questions: false,
      drafts: false,
      tokens: this.supportsTokens(),
      cost: false,
      titles: this.supportsTitles(),
    };
  }

  supportsTokens() {
    return false;
  }

  supportsTitles() {
    return "derived";
  }

  async health() {
    const root = this.rootPath();
    if (!root || !fs.existsSync(root)) {
      return { ok: false, detail: `not found: ${root}` };
    }
    return { ok: true, detail: `${this.constructor.name} transcripts at ${root}` };
  }

  streamConnected() {
    return false;
  }

  getLiveState(sessionId) {
    const state = this.sessionStates.get(sessionId);
    if (state === "running") return { status: "running", at: Date.now() };
    return null;
  }

  dispose() {
    this.parseCache.clear();
    this.sessionStates.clear();
  }

  rootPath() {
    return this.config.projectsRoot || this.config.sessionsRoot || "";
  }

  // Configured directories filter by exact cwd match; empty = everything.
  directoryFilter() {
    const configured = Array.isArray(this.config.directories) ? this.config.directories : [];
    if (!configured.length) return null;
    return new Set(configured.map((directory) => path.normalize(directory)));
  }

  decoratedRow(fields, basedir) {
    return this.plugin.decorateRow(
      {
        ...fields,
        connectorId: this.connector.id,
        connectorName: this.connector.name,
        source: this.connector.kind,
        readOnly: true,
      },
      basedir,
    );
  }

  async listSessions(options = {}) {
    const { basedir, directories } = this.plugin.resolveDirectories(options, this.connector);
    // Block-level `dirs` act as an additional exact-match filter (parity
    // with opencode listing); connector-configured directories do the same.
    const wantedPaths = new Set(
      [...(directories.length ? directories : []), ...(this.directoryFilter() || [])].map((d) =>
        path.normalize(d),
      ),
    );
    const wantedSlugs = new Set([...wantedPaths].map((directory) => slugifyPath(directory)));
    const entries = await this.enumerateSessions();
    const rows = [];
    for (const entry of entries) {
      let fields;
      try {
        fields = await this.scanSession(entry);
      } catch {
        continue; // unreadable/corrupt file: skipped, never fatal
      }
      if (!fields) continue;
      // Filter AFTER scanning: codex resolves its directory from
      // session_meta during the scan.
      if (!directoryMatchesFilter(entry, wantedPaths, wantedSlugs)) continue;
      const resolvedDirectory = displayDirectoryFor(entry, wantedPaths) || fields.directory || entry.directory;
      this.sessionStates.set(entry.id, fields.state || "idle");
      rows.push(
        this.decoratedRow(
          { ...entry.extra, ...fields, id: entry.id, directory: resolvedDirectory },
          basedir,
        ),
      );
    }
    return rows.sort((a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0));
  }

  // Subclass contract ---------------------------------------------------------

  // enumerateSessions() -> [{ id, file, directory, extra? }] (readdir+stat only)
  // scanSession(entry) -> { title, model, agent, time_created, time_updated,
  //                         tokens_*, state } via cheap head/tail reads
  // parseSessionFile(entry) -> { session, messages } full parse

  // Pinned-id lookups (widget mode): scan only the requested ids, in order.
  async loadSessionRowsByIds(ids) {
    const entries = await this.enumerateSessions();
    const byId = new Map();
    for (const entry of entries) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
    const rows = [];
    const missing = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        missing.push(id);
        continue;
      }
      try {
        const fields = await this.scanSession(entry);
        if (fields) {
          this.sessionStates.set(id, fields.state || "idle");
          rows.push(
            this.decoratedRow(
              { ...entry.extra, ...fields, id, directory: fields.directory || entry.directory },
              "",
            ),
          );
          continue;
        }
      } catch {
        // fall through to missing
      }
      missing.push(id);
    }
    return { rows, missing };
  }

  async getSession(sessionId) {
    const parsed = await this.parseSession(sessionId);
    return parsed ? parsed.session : null;
  }

  async listMessages(sessionId, options = {}) {
    const parsed = await this.parseSession(sessionId);
    if (!parsed) return { data: [], cursor: { next: null } };
    return paginateMessages(parsed.messages, options);
  }

  // Memoizes in-flight parses (loadInitial fires getSession + listMessages
  // concurrently over the same file) and evicts old entries LRU-style.
  parseSession(sessionId) {
    const inflight = this.parseInflight.get(sessionId);
    if (inflight) return inflight;
    const promise = this.parseSessionUncached(sessionId)
      .catch((error) => {
        this.parseInflight.delete(sessionId);
        throw error;
      })
      .then((parsed) => {
        if (this.parseInflight.get(sessionId) === promise) this.parseInflight.delete(sessionId);
        return parsed;
      });
    this.parseInflight.set(sessionId, promise);
    return promise;
  }

  async parseSessionUncached(sessionId) {
    const entry = await this.findSessionEntry(sessionId);
    if (!entry) return null;
    const stat = fs.statSync(entry.file);
    if (stat.size > FileConnectorDriver.MAX_PARSE_BYTES) {
      throw new Error(
        `Session transcript is ${Math.round(stat.size / 1024 / 1024)} MB — too large to display (limit ${Math.round(FileConnectorDriver.MAX_PARSE_BYTES / 1024 / 1024)} MB).`,
      );
    }
    const cached = this.parseCache.get(sessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // LRU touch: re-insert at the end.
      this.parseCache.delete(sessionId);
      this.parseCache.set(sessionId, cached);
      return cached;
    }
    const parsed = await this.parseSessionFile(entry);
    this.parseCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed });
    while (this.parseCache.size > FileConnectorDriver.PARSE_CACHE_LIMIT) {
      const oldest = this.parseCache.keys().next().value;
      this.parseCache.delete(oldest);
    }
    return parsed;
  }
}

// Tool outputs can be enormous (command dumps, full file reads); cap them
// for display with an explicit truncation marker.
function capToolOutput(text) {
  const value = String(text ?? "");
  const limit = FileConnectorDriver.MAX_TOOL_OUTPUT_CHARS;
  return value.length > limit
    ? `${value.slice(0, limit)}\n… [truncated ${value.length - limit} characters]`
    : value;
}

// Synthetic pagination over an in-memory message list: emulates the v2
// cursor API (pages of `limit`, newest first, "next" points to older).
function paginateMessages(messages, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : DEFAULT_MESSAGE_PAGE;
  let consumed = 0;
  if (typeof options.cursor === "string" && options.cursor.startsWith("offset:")) {
    consumed = Math.max(0, Number(options.cursor.slice(7)) || 0);
  }
  const end = Math.max(0, messages.length - consumed);
  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end).reverse(); // newest→oldest
  const nextConsumed = consumed + page.length;
  return {
    data: page,
    cursor: { next: nextConsumed < messages.length ? `offset:${nextConsumed}` : null },
  };
}

// --- Claude Code --------------------------------------------------------------

class ClaudeCodeDriver extends FileConnectorDriver {
  supportsTokens() {
    return true; // summed usage available on chat open (full parse)
  }

  supportsTitles() {
    return "stored"; // ai-title lines
  }

  async health() {
    const root = this.rootPath();
    if (!fs.existsSync(root)) {
      return { ok: false, detail: `not found: ${root}` };
    }
    return { ok: true, detail: `Claude Code transcripts at ${root}` };
  }

  async enumerateSessions() {
    const root = this.rootPath();
    const configured = Array.isArray(this.config.directories) ? this.config.directories : [];
    const entries = [];
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    } catch {
      return entries;
    }
    for (const slug of projectDirs) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(root, slug));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        entries.push({
          id: file.replace(/\.jsonl$/, ""),
          file: path.join(root, slug, file),
          encodedDir: slug,
          directory: decodeEncodedDir(slug, configured),
        });
      }
    }
    return entries;
  }

  async findSessionEntry(sessionId) {
    const entries = await this.enumerateSessions();
    return entries.find((entry) => entry.id === sessionId) || null;
  }

  // Cheap scan: title/model from the tail (latest), timestamps from both
  // ends. Token totals need a full parse and stay empty in listings.
  async scanSession(entry) {
    const { head, tail, stat } = readHeadTail(entry.file, 64 * 1024, 256 * 1024);
    let firstTime = null;
    let lastTime = null;
    let title = null;
    let model = null;
    let lastType = null;
    const visitHead = (line) => {
      const ts = epochMs(line.timestamp);
      if (ts && firstTime == null) firstTime = ts;
    };
    const visitTail = (line) => {
      const ts = epochMs(line.timestamp);
      if (ts) lastTime = ts;
      if (line.type === "ai-title" && typeof line.aiTitle === "string" && line.aiTitle) title = line.aiTitle;
      if (line.type === "assistant" && line.message?.model) model = line.message.model;
      if (line.type === "user" || line.type === "assistant") lastType = line.type;
    };
    eachJsonLine(head, visitHead);
    // Small files (≤ headBytes) return an empty tail — the head IS the whole
    // file then, so scan it for title/model/lastType too (Cursor-style).
    eachJsonLine(tail || head, visitTail);
    return {
      title,
      model,
      agent: "claude-code",
      time_created: firstTime ?? Math.round(stat.birthtimeMs),
      time_updated: lastTime ?? Math.round(stat.mtimeMs),
      state: this.freshnessState(stat, lastType),
    };
  }

  freshnessState(stat, lastType) {
    if (Date.now() - stat.mtimeMs > RUNNING_STALE_MS) return "idle";
    // A session still awaiting its assistant reply reads as running.
    return lastType === "user" ? "running" : "idle";
  }

  async parseSessionFile(entry) {
    const text = fs.readFileSync(entry.file, "utf8");
    const messages = [];
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let title = null;
    let model = null;
    let firstTime = null;
    let lastTime = null;
    // tool_use_id -> { messageIndex, part } for attaching later results.
    const pendingTools = new Map();
    let index = 0;
    eachJsonLine(text, (line) => {
      const ts = epochMs(line.timestamp);
      if (ts) {
        if (firstTime == null) firstTime = ts;
        lastTime = ts;
      }
      if (line.type === "ai-title" && line.aiTitle) {
        title = line.aiTitle;
        return;
      }
      if (line.isSidechain) return; // subagent transcripts
      if (line.type !== "user" && line.type !== "assistant") return;
      const message = line.message;
      if (!message || typeof message !== "object") return;
      if (line.type === "assistant") {
        if (message.model) model = message.model;
        const usageInfo = message.usage || {};
        usage.input += Number(usageInfo.input_tokens) || 0;
        usage.output += Number(usageInfo.output_tokens) || 0;
        usage.reasoning += Number(usageInfo.output_tokens_details?.thinking_tokens) || 0;
        usage.cacheRead += Number(usageInfo.cache_read_input_tokens) || 0;
        usage.cacheWrite += Number(usageInfo.cache_creation_input_tokens) || 0;
        const content = [];
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
          if (block?.type === "text" && block.text) {
            content.push({ type: "text", text: block.text });
          } else if (block?.type === "thinking" && block.thinking) {
            content.push({ type: "reasoning", text: block.thinking });
          } else if (block?.type === "tool_use") {
            const part = {
              type: "tool",
              id: block.id,
              name: block.name || "tool",
              state: { status: "running", input: block.input ?? {} },
            };
            content.push(part);
            if (block.id) pendingTools.set(block.id, part);
          }
        }
        messages.push({
          id: line.uuid || `claude-${index}`,
          type: "assistant",
          agent: "claude-code",
          model: message.model || null,
          time: { created: ts },
          content,
        });
        index += 1;
        return;
      }
      // user line: plain text or tool_result blocks
      const raw = message.content;
      if (typeof raw === "string") {
        messages.push({
          id: line.uuid || `claude-${index}`,
          type: "user",
          time: { created: ts },
          text: raw,
        });
        index += 1;
        return;
      }
      if (!Array.isArray(raw)) return;
      const textParts = [];
      for (const block of raw) {
        if (block?.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block?.type === "tool_result" && block.tool_use_id) {
          const part = pendingTools.get(block.tool_use_id);
          if (part) {
            pendingTools.delete(block.tool_use_id);
            const output = Array.isArray(block.content)
              ? block.content.map((b) => (b?.type === "text" ? b.text : "")).filter(Boolean).join("\n")
              : String(block.content ?? "");
            part.state = {
              status: block.is_error ? "error" : "completed",
              input: part.state.input,
              content: output ? [{ type: "text", text: capToolOutput(output) }] : [],
            };
          }
        }
      }
      if (textParts.length) {
        messages.push({
          id: line.uuid || `claude-${index}`,
          type: "user",
          time: { created: ts },
          text: textParts.join("\n\n"),
        });
        index += 1;
      }
    });
    return {
      session: {
        id: entry.id,
        title: title || "Untitled session",
        agent: "claude-code",
        model: model ? String(model) : null,
        cost: 0,
        tokens:
          usage.input || usage.output || usage.reasoning || usage.cacheRead || usage.cacheWrite
            ? {
                input: usage.input,
                output: usage.output,
                reasoning: usage.reasoning,
                cache: { read: usage.cacheRead, write: usage.cacheWrite },
              }
            : null,
        time: { created: firstTime, updated: lastTime },
        location: { directory: entry.directory },
      },
      messages,
    };
  }
}

// --- Codex CLI ------------------------------------------------------------------

class CodexDriver extends FileConnectorDriver {
  supportsTokens() {
    return true; // cumulative token_count events
  }

  async health() {
    const root = this.rootPath();
    if (!fs.existsSync(root)) {
      return { ok: false, detail: `not found: ${root}` };
    }
    return { ok: true, detail: `Codex CLI rollouts at ${root}` };
  }

  async enumerateSessions() {
    const root = this.rootPath();
    const entries = [];
    const walk = (directory, depth) => {
      let dirents = [];
      try {
        dirents = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const full = path.join(directory, dirent.name);
        if (dirent.isDirectory() && depth < 3) {
          walk(full, depth + 1);
          continue;
        }
        const match = /^rollout-(.+)-([0-9a-fA-F-]{36})\.jsonl(\.zst)?$/.exec(dirent.name);
        if (!match) continue;
        entries.push({
          id: match[2],
          file: full,
          compressed: !!match[3],
          // Filename time: rollout-YYYY-MM-DDTHH-MM-SS-<uuid> (time dashes
          // stand for colons).
          filenameTime: codexFilenameTime(match[1]),
          // cwd comes from session_meta during scan; placeholder until then.
          directory: "",
          extra: {},
        });
      }
    };
    walk(root, 0);
    // The same session can exist as both .jsonl and .jsonl.zst (cold
    // compression); prefer the plain file deterministically.
    const byId = new Map();
    for (const entry of entries) {
      const existing = byId.get(entry.id);
      if (!existing || (existing.compressed && !entry.compressed)) {
        byId.set(entry.id, entry);
      }
    }
    return [...byId.values()];
  }

  async findSessionEntry(sessionId) {
    const entries = await this.enumerateSessions();
    return entries.find((entry) => entry.id === sessionId) || null;
  }

  async readEntryText(entry, headBytes, tailBytes) {
    if (!entry.compressed) {
      if (headBytes || tailBytes) {
        const { head, tail, stat } = readHeadTail(entry.file, headBytes || 64 * 1024, tailBytes || 128 * 1024);
        return { head, tail, stat };
      }
      return { text: fs.readFileSync(entry.file, "utf8"), stat: fs.statSync(entry.file) };
    }
    const zstdPath = resolveZstdExecutable(this.config.zstdPath);
    const text = await runExternal(zstdPath, ["-dc", entry.file]);
    const stat = fs.statSync(entry.file);
    if (!headBytes && !tailBytes) {
      // The pre-parse stat.size check sees the COMPRESSED size; the cap
      // applies to what lands in the renderer heap — re-check decompressed.
      const bytes = Buffer.byteLength(text);
      if (bytes > FileConnectorDriver.MAX_PARSE_BYTES) {
        throw new Error(
          `Session transcript is ${Math.round(bytes / 1024 / 1024)} MB decompressed — too large to display (limit ${Math.round(FileConnectorDriver.MAX_PARSE_BYTES / 1024 / 1024)} MB).`,
        );
      }
      return { text, stat };
    }
    const size = text.length;
    return {
      head: text.slice(0, headBytes || 64 * 1024),
      tail: size > (tailBytes || 128 * 1024) ? text.slice(-(tailBytes || 128 * 1024)) : "",
      stat,
    };
  }

  async scanSession(entry) {
    if (entry.compressed) {
      // Compressed rollouts decompress on open only; listing uses filename
      // timestamps and a placeholder title.
      const stat = fs.statSync(entry.file);
      return {
        title: null,
        model: null,
        agent: "codex",
        time_created: entry.filenameTime ?? Math.round(stat.birthtimeMs),
        time_updated: Math.round(stat.mtimeMs),
        state: "idle",
        compressed: true,
      };
    }
    const { head, tail, stat } = await this.readEntryText(entry, 256 * 1024, 128 * 1024);
    let cwd = null;
    let title = null;
    let model = null;
    let firstTime = null;
    let lastTime = null;
    let tokens = null;
    let lastSignal = null;
    eachJsonLine(head, (line) => {
      if (line.type === "session_meta" && line.payload?.cwd) cwd = line.payload.cwd;
      const ts = epochMs(line.timestamp);
      if (ts && firstTime == null) firstTime = ts;
      if (!title && this.isUserPrompt(line)) {
        const text = this.promptText(line);
        if (!looksLikeInjectedContext(text)) title = deriveTitle(text);
      }
      if (line.type === "turn_context" && line.payload?.model) model = line.payload.model;
    });
    eachJsonLine(tail || head, (line) => {
      const ts = epochMs(line.timestamp);
      if (ts) lastTime = ts;
      if (line.type === "turn_context" && line.payload?.model) model = line.payload.model;
      const totals = line.payload?.info?.total_token_usage;
      if (line.type === "event_msg" && line.payload?.type === "token_count" && totals) {
        tokens = totals;
      }
      if (line.type === "event_msg") {
        const kind = line.payload?.type;
        if (kind === "task_started") lastSignal = "started";
        else if (kind === "task_complete" || kind === "task_end" || kind === "turn_aborted") lastSignal = "ended";
      }
    });
    if (cwd) entry.directory = cwd;
    return {
      title,
      model,
      agent: "codex",
      time_created: firstTime ?? Math.round(stat.birthtimeMs),
      time_updated: lastTime ?? Math.round(stat.mtimeMs),
      tokens_input: tokens ? Number(tokens.input_tokens) || 0 : 0,
      tokens_output: tokens ? Number(tokens.output_tokens) || 0 : 0,
      tokens_reasoning: tokens ? Number(tokens.reasoning_output_tokens) || 0 : 0,
      state: this.freshnessState(stat, lastSignal),
    };
  }

  freshnessState(stat, lastSignal) {
    if (Date.now() - stat.mtimeMs > RUNNING_STALE_MS) return "idle";
    return lastSignal === "started" ? "running" : "idle";
  }

  // User prompts arrive as response_item messages with role "user" — but the
  // CLI also injects context (AGENTS.md, permissions) as user/developer
  // messages. Real prompts read as plain prose without the wrappers.
  isUserPrompt(line) {
    if (line.type === "input_item") return true;
    if (line.type !== "response_item" || line.payload?.type !== "message") return false;
    if (line.payload.role !== "user") return false;
    return true;
  }

  promptText(line) {
    if (line.type === "input_item") {
      const payload = line.payload;
      return String(payload?.text ?? payload?.payload?.text ?? "");
    }
    const content = Array.isArray(line.payload?.content) ? line.payload.content : [];
    return content.map((block) => (block?.type === "input_text" ? block.text : "")).filter(Boolean).join("\n");
  }

  async parseSessionFile(entry) {
    const { text } = await this.readEntryText(entry);
    const messages = [];
    let cwd = null;
    let model = null;
    let title = null;
    let firstTime = null;
    let lastTime = null;
    let tokens = null;
    // Current turn's assistant message (parts accumulate in order).
    let turnMessage = null;
    const toolsByCallId = new Map();
    let index = 0;

    const flushTurn = () => {
      if (turnMessage && turnMessage.content.length) {
        messages.push(turnMessage);
        index += 1;
      }
      turnMessage = null;
    };
    const ensureTurn = (ts) => {
      if (!turnMessage) {
        turnMessage = {
          id: `codex-turn-${index}`,
          type: "assistant",
          agent: "codex",
          model: model || null,
          time: { created: ts },
          content: [],
        };
      }
      return turnMessage;
    };

    eachJsonLine(text, (line) => {
      const ts = epochMs(line.timestamp);
      if (ts) {
        if (firstTime == null) firstTime = ts;
        lastTime = ts;
      }
      const payload = line.payload;
      switch (line.type) {
        case "session_meta":
          cwd = payload?.cwd || cwd;
          break;
        case "turn_context":
          if (payload?.model) model = payload.model;
          break;
        case "event_msg": {
          const kind = payload?.type;
          if (kind === "token_count" && payload?.info?.total_token_usage) {
            tokens = payload.info.total_token_usage;
          }
          if (kind === "task_started") {
            flushTurn();
          } else if (kind === "task_complete" || kind === "task_end" || kind === "turn_aborted") {
            flushTurn();
          }
          break;
        }
        case "input_item":
        case "response_item": {
          if (payload?.type === "message") {
            const role = payload.role;
            const contentText = (Array.isArray(payload.content) ? payload.content : [])
              .map((block) => (block?.type === "output_text" || block?.type === "input_text" ? block.text : ""))
              .filter(Boolean)
              .join("\n");
            if (role === "assistant") {
              if (contentText) ensureTurn(ts).content.push({ type: "text", text: contentText });
            } else if (!looksLikeInjectedContext(contentText) && (line.type === "input_item" || role === "user")) {
              if (!title && contentText) title = deriveTitle(contentText);
              flushTurn();
              messages.push({
                id: `codex-${index}`,
                type: "user",
                time: { created: ts },
                text: contentText,
              });
              index += 1;
            } else {
              // developer / injected environment context — collapsed note
              flushTurn();
              messages.push({
                id: `codex-${index}`,
                type: "system",
                time: { created: ts },
                text: deriveTitle(contentText) || "context",
              });
              index += 1;
            }
          } else if (payload?.type === "reasoning") {
            const summary = Array.isArray(payload.summary)
              ? payload.summary.map((item) => item?.text || "").filter(Boolean).join("\n")
              : "";
            if (summary) ensureTurn(ts).content.push({ type: "reasoning", text: summary });
          } else if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
            // custom_tool_call is how apply_patch (file edits) is recorded:
            // {call_id, name, input} instead of {call_id, name, arguments}.
            const part = {
              type: "tool",
              id: payload.call_id,
              name: payload.name || "tool",
              state: { status: "running", input: payload.input ?? payload.arguments ?? "" },
            };
            ensureTurn(ts).content.push(part);
            if (payload.call_id) toolsByCallId.set(payload.call_id, part);
          } else if (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") {
            const part = payload.call_id ? toolsByCallId.get(payload.call_id) : null;
            if (part) {
              toolsByCallId.delete(payload.call_id);
              part.state = {
                status: "completed",
                input: part.state.input,
                content: payload.output != null
                  ? [{ type: "text", text: capToolOutput(String(payload.output)) }]
                  : [],
              };
            }
          }
          break;
        }
        default:
          break;
      }
    });
    flushTurn();
    if (cwd) entry.directory = cwd;
    return {
      session: {
        id: entry.id,
        title: title || "Untitled session",
        agent: "codex",
        model: model ? String(model) : null,
        cost: 0,
        tokens: tokens
          ? {
              input: Number(tokens.input_tokens) || 0,
              output: Number(tokens.output_tokens) || 0,
              reasoning: Number(tokens.reasoning_output_tokens) || 0,
            }
          : null,
        time: { created: firstTime, updated: lastTime },
        location: { directory: cwd || entry.directory },
      },
      messages,
    };
  }
}

// --- Cursor Agent (IDE transcripts) ----------------------------------------------

class CursorDriver extends FileConnectorDriver {
  supportsTokens() {
    return false;
  }

  async health() {
    const root = this.rootPath();
    if (!fs.existsSync(root)) {
      return { ok: false, detail: `not found: ${root}` };
    }
    return { ok: true, detail: `Cursor agent transcripts at ${root}` };
  }

  async enumerateSessions() {
    const root = this.rootPath();
    const configured = Array.isArray(this.config.directories) ? this.config.directories : [];
    const entries = [];
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    } catch {
      return entries;
    }
    for (const encoded of projectDirs) {
      const transcriptsRoot = path.join(root, encoded, "agent-transcripts");
      let sessionDirs = [];
      try {
        sessionDirs = fs.readdirSync(transcriptsRoot, { withFileTypes: true })
          .filter((dirent) => dirent.isDirectory())
          .map((dirent) => dirent.name);
      } catch {
        continue;
      }
      for (const sessionId of sessionDirs) {
        const file = path.join(transcriptsRoot, sessionId, `${sessionId}.jsonl`);
        if (!fs.existsSync(file)) continue;
        entries.push({
          id: sessionId,
          file,
          encodedDir: encoded,
          directory: decodeEncodedDir(encoded, configured),
        });
      }
    }
    return entries;
  }

  async findSessionEntry(sessionId) {
    const entries = await this.enumerateSessions();
    return entries.find((entry) => entry.id === sessionId) || null;
  }

  // Transcripts carry no timestamps (file stat is the only clock) and no
  // titles (derived from the first user message). Freshness reads a small
  // tail so the LAST line decides running/idle even in long transcripts.
  async scanSession(entry) {
    const { head, tail, stat } = readHeadTail(entry.file, 64 * 1024, 8 * 1024);
    let title = null;
    let lastType = null;
    eachJsonLine(head, (line) => {
      if (line.role === "user" && !title) {
        const text = (Array.isArray(line.message?.content) ? line.message.content : [])
          .map((block) => (block?.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        title = deriveTitle(text);
      }
    });
    const tailLines = tail ? String(tail).split(/\r?\n/).filter((l) => l.trim()) : [];
    const visitLast = (line) => {
      if (line.role) lastType = line.role;
      if (line.type === "turn_ended") lastType = "turn_ended";
    };
    // Prefer the true last line from the tail; fall back to the head for
    // small files (readHeadTail returns an empty tail then).
    if (tailLines.length) {
      for (let i = tailLines.length - 1; i >= 0; i -= 1) {
        try {
          visitLast(JSON.parse(tailLines[i]));
          break;
        } catch {
          continue;
        }
      }
    } else {
      eachJsonLine(head, visitLast);
    }
    return {
      title,
      model: null,
      agent: "cursor-agent",
      time_created: Math.round(stat.birthtimeMs),
      time_updated: Math.round(stat.mtimeMs),
      state: this.freshnessState(stat, lastType),
    };
  }

  freshnessState(stat, lastType) {
    if (Date.now() - stat.mtimeMs > RUNNING_STALE_MS) return "idle";
    return lastType === "assistant" ? "running" : "idle";
  }

  async parseSessionFile(entry) {
    const text = fs.readFileSync(entry.file, "utf8");
    const messages = [];
    let title = null;
    const lines = String(text || "").split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const trimmed = lines[lineNumber].trim();
      if (!trimmed) continue;
      let line;
      try {
        line = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!line || typeof line !== "object") continue;
      if (line.type === "turn_ended") {
        // Transcripts record at most one turn_ended per file (a clean end);
        // with no tool outputs persisted, finalize all open tools there.
        for (const message of messages) {
          for (const part of message.content || []) {
            if (part.type === "tool" && part.state.status === "running") {
              part.state.status = "completed";
            }
          }
        }
        continue;
      }
      if (!line.role) continue;
      const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
      if (line.role === "user") {
        const textParts = blocks
          .map((block) => (block?.type === "text" ? block.text : ""))
          .filter(Boolean);
        if (textParts.length) {
          if (!title) title = deriveTitle(textParts.join("\n"));
          messages.push({
            id: `cursor-l${lineNumber}`,
            type: "user",
            time: null,
            text: extractPromptText(textParts.join("\n\n")),
          });
        }
        continue;
      }
      if (line.role === "assistant") {
        const content = [];
        for (const block of blocks) {
          if (block?.type === "text" && block.text) {
            content.push({ type: "text", text: block.text });
          } else if (block?.type === "tool_use") {
            content.push({
              type: "tool",
              id: block.id || `cursor-tool-${lineNumber}-${content.length}`,
              name: block.name || "tool",
              // Transcripts never record tool outputs; inputs are final.
              state: { status: "running", input: block.input ?? {} },
            });
          }
        }
        if (content.length) {
          messages.push({
            id: `cursor-l${lineNumber}`,
            type: "assistant",
            agent: "cursor-agent",
            model: null,
            time: null,
            content,
          });
        }
      }
    }
    return {
      session: {
        id: entry.id,
        title: title || "Untitled session",
        agent: "cursor-agent",
        model: null,
        cost: 0,
        tokens: null,
        time: {
          created: Math.round(fs.statSync(entry.file).birthtimeMs),
          updated: Math.round(fs.statSync(entry.file).mtimeMs),
        },
        location: { directory: entry.directory },
      },
      messages,
    };
  }
}

// --- OpenCode v1 (legacy SQLite) ------------------------------------------------
//
// v1 stored sessions in the same opencode.db: a `session` table (columns
// nearly identical to session_v2) plus `message`/`part` tables where each
// message's content parts live as separate rows (ULID ids, lexicographically
// chronological). Read-only and historical — no server, no event stream.

class OpenCode1Driver extends ConnectorDriver {
  constructor(plugin, connector) {
    super(plugin, connector);
    // sessionId -> { messages, at }: historical data, but a still-running
    // legacy opencode appends — entries expire so Refresh picks them up.
    this.parseCache = new Map();
  }

  static CACHE_TTL_MS = 30 * 1000;

  capabilities() {
    return {
      listing: "db",
      live: "none",
      messages: true,
      pagination: true, // in-memory over the session's merged messages
      chat: false,
      models: false,
      agents: false,
      permissions: false,
      questions: false,
      drafts: false,
      tokens: true,
      cost: true,
      titles: "stored",
    };
  }

  async health() {
    const settings = this.config;
    if (!fs.existsSync(settings.databasePath)) {
      return { ok: false, detail: `not found: ${settings.databasePath}` };
    }
    const tables = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')",
    );
    const found = new Set(tables.map((row) => row.name));
    if (!found.has("session")) {
      return { ok: false, detail: `no v1 'session' table in ${settings.databasePath}` };
    }
    const count = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      "SELECT COUNT(*) AS n FROM session",
    );
    return {
      ok: true,
      detail: `OpenCode v1 database (${count[0]?.n || 0} sessions)${found.has("message") ? "" : " — messages missing"}`,
    };
  }

  streamConnected() {
    return false;
  }

  dispose() {
    this.parseCache.clear();
  }

  async listSessions(options = {}) {
    const settings = this.config;
    if (!fs.existsSync(settings.databasePath)) {
      throw new Error(`Database not found: ${settings.databasePath}`);
    }
    const { basedir, directories } = this.plugin.resolveDirectories(options, this.connector);
    if (!directories.length) return [];
    const directoryList = directories.map(quoteSql).join(", ");
    const customSql = validateSqlWhereFragment(
      options.customSql !== undefined ? options.customSql : settings.customSql,
    );
    // SQLite fallback state detection, v1 flavor: the newest message being
    // an unanswered user prompt (or an uncompleted assistant reply) reads
    // as running within the freshness window.
    const stateJoin =
      " LEFT JOIN message lm ON lm.session_id = session.id"
      + " AND lm.time_created = (SELECT MAX(time_created) FROM message WHERE session_id = session.id)";
    const clauses = [`directory IN (${directoryList})`];
    if (customSql) clauses.push(`(${customSql})`);
    const rows = (
      await runSqlite(
        settings.sqlitePath,
        settings.databasePath,
        `SELECT session.id, session.directory, session.title, session.model, session.agent, session.time_created, session.time_updated, session.cost, session.tokens_input, session.tokens_output, session.tokens_reasoning, session.time_archived, session.version`
        + `, json_extract(lm.data, '$.role') AS last_message_role`
        + `, json_extract(lm.data, '$.time.completed') AS last_completed`
        + `, lm.time_updated AS last_message_time`
        + ` FROM session${stateJoin} WHERE ${clauses.join(" AND ")} ORDER BY session.time_updated DESC`,
      )
    ).map((row) =>
      this.plugin.decorateRow(
        {
          ...row,
          time_suspended: null,
          state: this.heuristicState(row),
          connectorId: this.connector.id,
          connectorName: this.connector.name,
          source: "opencode1",
          readOnly: true,
        },
        basedir,
      ),
    );
    return rows.sort((a, b) => Number(b.time_updated || 0) - Number(a.time_updated || 0));
  }

  heuristicState(row) {
    const fresh = (value) => Number(value) && Date.now() - Number(value) < RUNNING_STALE_MS;
    if (
      (row.last_message_role === "assistant" && row.last_completed == null && fresh(row.last_message_time)) ||
      (row.last_message_role === "user" && fresh(row.time_updated))
    ) {
      return "running";
    }
    return "idle";
  }

  // Pinned-id lookups (widget mode); v1 sessions are historical, so rows
  // render idle like the v2 path's un-hinted lookups.
  async loadSessionRowsByIds(ids) {
    const settings = this.config;
    const rows = [];
    const missing = [];
    for (const id of ids) {
      try {
        const found = await runSqlite(
          settings.sqlitePath,
          settings.databasePath,
          `SELECT id, directory, title, model, agent, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, time_archived, version FROM session WHERE id = ${quoteSql(id)} LIMIT 1`,
        );
        const row = found[0];
        if (row) {
          rows.push(
            this.plugin.decorateRow(
              {
                ...row,
                time_suspended: null,
                state: "idle",
                connectorId: this.connector.id,
                connectorName: this.connector.name,
                source: "opencode1",
                readOnly: true,
              },
              "",
            ),
          );
        } else {
          missing.push(id);
        }
      } catch {
        missing.push(id);
      }
    }
    return { rows, missing };
  }

  async getSession(sessionId) {
    const settings = this.config;
    const rows = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      `SELECT id, directory, title, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session WHERE id = ${quoteSql(sessionId)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title || "Untitled session",
      agent: row.agent || "",
      model: row.model || null,
      cost: row.cost || 0,
      tokens: {
        input: row.tokens_input || 0,
        output: row.tokens_output || 0,
        reasoning: row.tokens_reasoning || 0,
        cache: { read: row.tokens_cache_read || 0, write: row.tokens_cache_write || 0 },
      },
      time: { created: row.time_created, updated: row.time_updated },
      location: { directory: row.directory },
    };
  }

  async listMessages(sessionId, options = {}) {
    const messages = await this.loadMessages(sessionId);
    return paginateMessages(messages, options);
  }

  async loadMessages(sessionId) {
    const cached = this.parseCache.get(sessionId);
    if (cached && Date.now() - cached.at < OpenCode1Driver.CACHE_TTL_MS) {
      return cached.messages;
    }
    const settings = this.config;
    // Field-level extraction instead of raw `data`: the sqlite3 CLI's JSON
    // output mode is pathologically slow escaping large TEXT blobs (v1
    // message envelopes embed summary diffs up to ~500KB), while scalar
    // json_extract calls stay instant. Display-heavy fields are capped.
    const messageRows = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      `SELECT id, time_created`
      + `, json_extract(data, '$.role') AS role`
      + `, json_extract(data, '$.agent') AS agent`
      + `, json_extract(data, '$.time.created') AS data_created`
      + `, json_extract(data, '$.time.completed') AS data_completed`
      + `, json_extract(data, '$.model') AS model_json`
      + `, json_extract(data, '$.providerID') AS provider_id`
      + `, json_extract(data, '$.modelID') AS model_id`
      + `, json_extract(data, '$.error.data.message') AS error_message`
      + ` FROM message WHERE session_id = ${quoteSql(sessionId)} ORDER BY time_created, id`,
    );
    const partRows = await runSqlite(
      settings.sqlitePath,
      settings.databasePath,
      `SELECT id, message_id`
      + `, json_extract(data, '$.type') AS type`
      + `, substr(json_extract(data, '$.text'), 1, 500000) AS text`
      + `, json_extract(data, '$.tool') AS tool`
      + `, json_extract(data, '$.state.status') AS status`
      + `, substr(json_extract(data, '$.state.input'), 1, 100000) AS input`
      + `, substr(json_extract(data, '$.state.output'), 1, 50000) AS output`
      + `, json_extract(data, '$.state.error') AS state_error`
      + `, json_extract(data, '$.files') AS files`
      + ` FROM part WHERE session_id = ${quoteSql(sessionId)} ORDER BY id`,
    );
    const partsByMessage = new Map();
    for (const row of partRows) {
      if (!row.type) continue;
      if (!partsByMessage.has(row.message_id)) partsByMessage.set(row.message_id, []);
      partsByMessage.get(row.message_id).push(row);
    }
    const messages = [];
    for (const row of messageRows) {
      const content = [];
      const userText = [];
      const parts = partsByMessage.get(row.id) || [];
      for (const part of parts) {
        if (part.type === "text" && part.text) {
          if (row.role === "user") userText.push(part.text);
          else content.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning" && part.text) {
          content.push({ type: "reasoning", text: part.text });
        } else if (part.type === "tool") {
          content.push({
            type: "tool",
            id: part.id,
            name: part.tool || "tool",
            state: {
              status: part.status || "completed",
              input: part.input ?? "",
              content: part.output != null ? [{ type: "text", text: capToolOutput(String(part.output)) }] : [],
              ...(part.state_error ? { error: { message: String(part.state_error) } } : {}),
            },
          });
        } else if (part.type === "patch") {
          let files = part.files;
          if (typeof files === "string") {
            try {
              files = JSON.parse(files);
            } catch {
              files = [];
            }
          }
          content.push({
            type: "tool",
            id: part.id,
            name: "patch",
            state: {
              status: "completed",
              input: JSON.stringify(Array.isArray(files) ? files : [], null, 2),
              content: [],
            },
          });
        }
        // step-start / step-finish / file / compaction / subtask: skipped
      }
      let model = null;
      if (typeof row.model_json === "string" && row.model_json.startsWith("{")) {
        try {
          model = JSON.parse(row.model_json);
        } catch {
          model = null;
        }
      } else if (row.provider_id || row.model_id) {
        model = { providerID: row.provider_id, modelID: row.model_id, id: row.model_id };
      }
      if (row.role === "user") {
        if (userText.length) {
          messages.push({
            id: row.id,
            type: "user",
            agent: row.agent || "",
            time: { created: row.data_created ?? row.time_created },
            text: userText.join("\n\n"),
          });
        }
        continue;
      }
      if (row.role === "assistant") {
        // Aborted turns leave part-less assistant messages; rendering them
        // as empty "…" pending dots would read as streaming in a connector
        // that can never stream.
        if (!content.length) continue;
        messages.push({
          id: row.id,
          type: "assistant",
          agent: row.agent || "",
          model,
          error: row.error_message ? { message: row.error_message } : undefined,
          time: {
            created: row.data_created ?? row.time_created,
            completed: row.data_completed ?? null,
          },
          content,
        });
      }
    }
    this.parseCache.set(sessionId, { messages, at: Date.now() });
    // Bound the cache the same way file drivers do.
    while (this.parseCache.size > FileConnectorDriver.PARSE_CACHE_LIMIT) {
      const oldest = this.parseCache.keys().next().value;
      this.parseCache.delete(oldest);
    }
    return messages;
  }
}

function createDriverFor(plugin, connector) {
  switch (connector.kind) {
    case "opencode1":
      return new OpenCode1Driver(plugin, connector);
    case "claude-code":
      return new ClaudeCodeDriver(plugin, connector);
    case "codex":
      return new CodexDriver(plugin, connector);
    case "cursor":
      return new CursorDriver(plugin, connector);
    case "opencode2":
    default:
      return new OpenCode2Driver(plugin, connector);
  }
}

// Capabilities for API surfacing; a broken descriptor must not take the
// whole config() call down with it.
function safeCapabilities(driver) {
  try {
    return driver.capabilities();
  } catch {
    return null;
  }
}

// Owns the drivers, resolves connectors by id/name, and picks the default
// one. Failures stay scoped to a connector: the registry never propagates
// one driver's errors into another's calls.
//
// Note: settings edits mutate the shared connector/config objects drivers
// hold references to, so no rebuild/diff pass is needed — only add/delete
// (and enable/disable) touch the registry. Per-connector status recording
// (lastError) arrives with the settings polish phase.
class ConnectorRegistry {
  constructor(plugin) {
    this.plugin = plugin;
    this.entries = new Map(); // connector id -> { connector, driver }
  }

  init() {
    for (const connector of this.plugin.settings.connectors || []) {
      this.create(connector);
    }
  }

  create(connector) {
    if (this.entries.has(connector.id)) return this.entries.get(connector.id);
    const entry = { connector, driver: createDriverFor(this.plugin, connector) };
    this.entries.set(connector.id, entry);
    // Disabled connectors stay registered (chats may still reference them)
    // but do not keep a live event connection.
    if (connector.enabled) entry.driver.start();
    return entry;
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.driver.dispose();
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  all() {
    return [...this.entries.values()];
  }

  enabled() {
    return this.all().filter(({ connector }) => connector.enabled);
  }

  get(id) {
    return (id && this.entries.get(id)) || null;
  }

  byName(name) {
    if (!name) return null;
    return this.all().find(({ connector }) => connector.name === name) || null;
  }

  // The configured default, else the first enabled connector; null when the
  // plugin has no usable connector at all.
  defaultConnector() {
    const preferred = this.get(this.plugin.settings.defaultConnectorId);
    if (preferred && preferred.connector.enabled) return preferred;
    return this.enabled()[0] || null;
  }
}

// ---------------------------------------------------------------------------
// Session notes. One ordinary markdown file per session, attached via a
// `session:` frontmatter id — never via the filename, so notes survive
// renames and moves anywhere in the vault. Lookup rides on Obsidian's
// metadataCache (frontmatter is already parsed in memory): one index pass
// at startup, then incremental updates from cache events. Works for every
// connector — notes live in the vault, not in the backend.
// ---------------------------------------------------------------------------

class SessionNotes {
  constructor(plugin) {
    this.plugin = plugin;
    // sessionId -> TFile (lookup) and TFile -> sessionId (bookkeeping, so a
    // frontmatter edit removes the stale mapping without a full rebuild).
    this.bySession = new Map();
    this.sessionByFile = new Map();
  }

  // Accepts the `session` frontmatter value in its YAML-decoded form.
  static sessionKeyOf(frontmatter) {
    const value = frontmatter?.session;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    return null;
  }

  // Startup / metadata-resolved pass. Cheap: reads only cached metadata,
  // never touches the disk.
  buildIndex() {
    this.bySession.clear();
    this.sessionByFile.clear();
    for (const file of this.app.vault.getMarkdownFiles()) this.indexFile(file);
  }

  // Upsert one file's index entry from its (possibly just-changed) cache.
  indexFile(file) {
    const previous = this.sessionByFile.get(file);
    let id = null;
    try {
      id = SessionNotes.sessionKeyOf(this.app.metadataCache.getFileCache(file)?.frontmatter);
    } catch {
      id = null;
    }
    if (!id) {
      if (previous) {
        this.sessionByFile.delete(file);
        if (this.bySession.get(previous) === file) this.bySession.delete(previous);
      }
      return null;
    }
    if (previous && previous !== id && this.bySession.get(previous) === file) {
      this.bySession.delete(previous);
    }
    this.bySession.set(id, file);
    this.sessionByFile.set(file, id);
    return id;
  }

  unindexFile(file) {
    const id = this.sessionByFile.get(file);
    if (!id) return;
    this.sessionByFile.delete(file);
    if (this.bySession.get(id) === file) this.bySession.delete(id);
  }

  // Renames mutate the TFile in place, so both maps stay valid — nothing to do.

  find(sessionId) {
    return this.bySession.get(sessionId) || null;
  }

  // Returns the existing note for the session, or creates one in the notes
  // folder as `<session-id>-<title>.md`. Filename collisions get a numeric
  // suffix; the index is authoritative, so this is cosmetic only.
  async ensureNote(sessionId, meta = {}) {
    const existing = this.find(sessionId);
    if (existing) return existing;
    const folder = this.plugin.settings.notesDir;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Already exists — the happy path.
    }
    const base = `${sessionId}-${sanitizeNoteName(meta.title)}`;
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 26) throw new Error("could not find a free note filename");
      const name = attempt === 1 ? base : `${base}-${attempt}`;
      const notePath = `${folder}/${name}.md`;
      if (this.app.vault.getAbstractFileByPath(notePath)) continue;
      const content = buildNoteContent({
        sessionId,
        connectorName: meta.connectorName || "",
        title: meta.title || "",
      });
      try {
        const file = await this.app.vault.create(notePath, content);
        // The metadata cache may not have parsed the new file yet; seed the
        // index directly so an immediate reopen finds it.
        this.bySession.set(sessionId, file);
        this.sessionByFile.set(file, sessionId);
        return file;
      } catch (error) {
        if (attempt > 25) throw error;
        // Raced with a concurrent create — retry with the next suffix.
      }
    }
  }

  get app() {
    return this.plugin.app;
  }
}

// ---------------------------------------------------------------------------
// Dashboard (session list) — same renderer for the dedicated view and for
// ```vibed blocks embedded in notes.
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
    // Connectors are referenced by name in block configs; omitting one uses
    // the default connector. An unknown name is a visible error, not a
    // silent fallback.
    const connectorName =
      typeof options.connector === "string" && options.connector.trim()
        ? options.connector.trim()
        : null;
    // Explicitly named connectors pin this dashboard; without a name the
    // dashboard follows the default connector as settings change.
    this.requestedConnectorName = connectorName;
    this.connectorEntry = null;
    this.connectorId = null;
    this.connectorError = null;
  }

  // (Re)resolves the connector binding; runs on every load so default
  // switches, disables, and deletions take effect in mounted dashboards.
  refreshConnectorBinding() {
    if (this.requestedConnectorName) {
      const entry = this.plugin.registry.byName(this.requestedConnectorName);
      this.connectorEntry = entry;
      this.connectorId = entry?.connector.id || null;
      this.connectorError = entry ? null : `Unknown connector: ${this.requestedConnectorName}`;
      return;
    }
    this.connectorEntry = this.plugin.registry.defaultConnector();
    this.connectorId = this.connectorEntry?.connector.id || null;
    this.connectorError = null;
  }

  driver() {
    return this.connectorEntry?.driver || null;
  }

  connectorLabel() {
    // Chip text: show the connector name when it is not the implicit default.
    const name = this.connectorEntry?.connector.name;
    if (!name) return "";
    return name === this.plugin.registry.defaultConnector()?.connector.name ? "" : name;
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

  // Explicit `sessions:` ids listed in the block (deduped, order preserved).
  pinnedSessionIds() {
    const raw = this.options.sessions;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))];
  }

  // Widget mode: only explicit session ids, no dirs — a clean pinned strip
  // without the toolbar (refresh/search/new).
  sessionsOnlyMode() {
    return (
      this.pinnedSessionIds().length > 0 &&
      this.options.dirs === undefined &&
      this.options.directories === undefined
    );
  }

  async mount() {
    const { container } = this;
    container.addClass("opencode-sessions-dashboard");

    if (this.options.title) {
      container.createEl("h2", { text: String(this.options.title) });
    }

    if (!this.sessionsOnlyMode()) {
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
      // New sessions need a drafts-capable connector (OpenCode v2) — the
      // dashboard's own connector, not whatever is globally default.
      let draftsCapable = false;
      try {
        draftsCapable = !!this.plugin
          .driverForOptions({ connector: this.requestedConnectorName || undefined })
          ?.capabilities().drafts;
      } catch {
        draftsCapable = false;
      }
      if (draftsCapable) {
        const newButton = toolbar.createEl("button", { text: "New session" });
        newButton.addEventListener("click", () =>
          this.plugin.newSession({
            dirs: this.options.dirs,
            basedir: this.options.basedir,
            connector: this.requestedConnectorName || undefined,
          }),
        );
      }
      if (this.options.showSettings) {
        const settingsButton = toolbar.createEl("button", { text: "Settings" });
        settingsButton.addEventListener("click", () => this.plugin.openSettings());
      }
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
    this.refreshConnectorBinding();
    if (this.connectorError) {
      this.errorEl.setText(`OpenCode sessions error: ${this.connectorError}`);
      this.sessions = [];
      this.render();
      return;
    }
    const driver = this.driver();
    if (!driver || !this.connectorEntry.connector.enabled) {
      this.errorEl.setText("No connector configured — add one in OpenCode Sessions settings.");
      this.sessions = [];
      this.render();
      return;
    }
    const pinnedIds = this.pinnedSessionIds();
    let pinnedRows = [];
    let missingRows = [];
    try {
      if (pinnedIds.length) {
        const { rows, missing } = await driver.loadSessionRowsByIds(pinnedIds);
        pinnedRows = rows;
        missingRows = missing.map((id) => this.plugin.missingSessionRow(id, this.connectorEntry));
      }
      if (this.sessionsOnlyMode()) {
        this.sessions = [...pinnedRows, ...missingRows];
      } else {
        const rows = await driver.listSessions({
          dirs: this.options.dirs,
          basedir: this.options.basedir,
        });
        // Pinned sessions lead; exclude them from the directory-driven list
        // so nothing shows up twice.
        const pinnedSet = new Set(pinnedIds);
        this.sessions = [...pinnedRows, ...rows.filter((row) => !pinnedSet.has(row.id)), ...missingRows];
      }
      this.errorEl.setText("");
    } catch (error) {
      if (this.disposed) return;
      this.errorEl.setText(
        `OpenCode sessions unavailable: ${error.message}`,
      );
      this.sessions = [...pinnedRows, ...missingRows];
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
    const sessionsOnly = this.sessionsOnlyMode();
    // Widget mode shows everything listed; paginated mode never truncates
    // the pinned rows off the first page.
    const shown = sessionsOnly
      ? filtered
      : filtered.slice(0, Math.max(this.visible, this.pinnedSessionIds().length));
    if (this.statusEl) {
      let live;
      try {
        const caps = this.driver()?.capabilities();
        live = caps?.listing === "files"
          ? " · watching files"
          : caps?.live === "none"
            ? " · historical"
            : this.driver()?.streamConnected()
              ? " · live"
              : " · offline (db)";
      } catch {
        live = "";
      }
      const via = this.connectorLabel() ? ` · via ${this.connectorLabel()}` : "";
      this.statusEl.setText(
        `${filtered.length} of ${this.sessions.length} session${filtered.length === 1 ? "" : "s"}${live}${via}`,
      );
    }
    this.listEl.empty();
    if (this.layout() === "table") {
      this.renderTable(shown);
    } else {
      this.renderCards(shown);
    }
    const remaining = sessionsOnly ? 0 : filtered.length - shown.length;
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
        cls: `opencode-sessions-card opencode-sessions-card-${session.state || "none"}${session.missing ? " opencode-sessions-card-missing" : ""}`,
      });
      card.addEventListener("click", () =>
        this.plugin.openSession({ connectorId: this.connectorId, sessionId: session.id }),
      );
      const head = card.createDiv({ cls: "opencode-sessions-card-head" });
      const title = head.createSpan({
        cls: "opencode-sessions-card-title",
        text: session.missing ? `${session.titleLabel} (not found)` : session.titleLabel,
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
      row.addEventListener("click", () =>
        this.plugin.openSession({ connectorId: this.connectorId, sessionId: session.id }),
      );
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
    this.sessionId = plugin.pendingSessionRef?.sessionId || null;
    this.connectorId = plugin.pendingSessionRef?.connectorId || null;
    plugin.pendingSessionRef = null;
    // Connector name persisted alongside the id for resilience when the
    // connector was deleted between reloads (fall back by name, then default).
    this.connectorName = null;
    this.connector = null;
    this.driver = null;
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
    this.pendingQuestion = null;
    this.replyingQuestion = false;
    // question key -> selected option value(s), custom text, boolean, number
    this.questionAnswers = new Map();
    this.lastLoadedAt = 0;
    this.refreshing = false;
    // Session notes panel: file binding + debounced autosave bookkeeping.
    this.notesOpen = false;
    this.notesPanelEl = null;
    this.noteFile = null;
    this.noteFrontmatter = null;
    this.noteArea = null;
    this.noteStatusEl = null;
    this.noteSaveTimer = null;
    this.noteSavePending = false;
    this.noteBody = "";
    this.noteLoadedFor = null;
    this.noteSeq = 0;
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

  // Resolves the owning connector: by id, then persisted name, then the
  // default connector (covers legacy states and deleted connectors).
  resolveConnector() {
    const registry = this.plugin.registry;
    if (!registry) {
      this.connector = null;
      this.driver = null;
      return;
    }
    const entry =
      (this.connectorId ? registry.get(this.connectorId) : null) ||
      (this.connectorName ? registry.byName(this.connectorName) : null) ||
      registry.defaultConnector();
    this.connector = entry?.connector || null;
    this.driver = entry?.driver || null;
    // Always sync to the resolved connector: a stale id (connector deleted
    // between reloads) must not linger — it keys SSE subscriptions, view
    // dedupe, and persisted state.
    if (this.connector) {
      this.connectorId = this.connector.id;
      this.connectorName = this.connector.name;
    }
  }

  // Persist across Obsidian reloads: workspace.json otherwise restores
  // `"state": {}` and the tab keeps a stale title with no content.
  // Obsidian calls setState() before onOpen() on restore.
  getState() {
    return {
      sessionId: this.sessionId,
      draftDirectory: this.draftDirectory,
      connectorId: this.connectorId || this.connector?.id || null,
      connectorName: this.connectorName || this.connector?.name || null,
      notesOpen: this.notesOpen,
    };
  }

  async setState(state) {
    if (state && typeof state === "object") {
      if (typeof state.connectorId === "string" && state.connectorId && !this.connectorId) {
        this.connectorId = state.connectorId;
      }
      if (typeof state.connectorName === "string" && state.connectorName && !this.connectorName) {
        this.connectorName = state.connectorName;
      }
      if (typeof state.notesOpen === "boolean") {
        this.notesOpen = state.notesOpen;
      }
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

  // Cache the capability descriptor per view; a broken driver must not
  // take the chat down with it.
  driverCapabilities() {
    if (!this.capsCache) {
      try {
        this.capsCache = this.driver?.capabilities() || {};
      } catch {
        this.capsCache = {};
      }
    }
    return this.capsCache;
  }

  // File connectors have no event stream; a light poll reconciles the chat
  // (the parse cache makes untouched files free).
  startPollingIfFileBacked() {
    if (this.filePollTimer || !(this.driver instanceof FileConnectorDriver)) return;
    if (!this.driverCapabilities().messages) return;
    this.filePollTimer = window.setInterval(() => {
      if (this.unsubscribed) return;
      this.reconcileNow().catch(() => {});
    }, 3000);
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("opencode-session-view");
    this.resolveConnector();
    if (!this.driver) {
      this.contentEl.createDiv({
        cls: "opencode-session-empty",
        text: "Connector unavailable — it may have been removed in OpenCode Sessions settings.",
      });
      return;
    }
    if (this.sessionId) {
      this.buildSkeleton();
      this.bindSession(this.sessionId);
      this.unsubscribeStream = this.plugin.subscribe(() => this.updateComposer());
      this.startPollingIfFileBacked();
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
      this.loadAgents().catch(() => {});
      return;
    }
    this.contentEl.createDiv({ cls: "opencode-session-empty", text: "No session selected." });
  }

  // (Re)wires the per-session event listener; used on open and again when a
  // draft is promoted to a real session on the server. Session listeners are
  // keyed `${connectorId}:${sessionId}` so multiple connectors' event
  // streams never collide.
  bindSession(sessionId) {
    if (this.unsubscribeEvents) this.unsubscribeEvents();
    this.sessionId = sessionId;
    this.resolveConnector();
    const key = this.connectorId ? `${this.connectorId}:${sessionId}` : sessionId;
    this.unsubscribeEvents = this.plugin.subscribeSession(key, (event) =>
      this.onServerEvent(event),
    );
  }

  async onClose() {
    this.unsubscribed = true;
    // Flush an in-flight note edit: the debounce may have a keystroke left.
    if (this.noteSaveTimer) {
      window.clearTimeout(this.noteSaveTimer);
      this.noteSaveTimer = null;
      this.saveNoteNow().catch(() => {});
    }
    if (this.unsubscribeEvents) this.unsubscribeEvents();
    if (this.unsubscribeStream) this.unsubscribeStream();
    if (this.filePollTimer) {
      window.clearInterval(this.filePollTimer);
      this.filePollTimer = null;
    }
    if (this.reconcileTimer) window.clearTimeout(this.reconcileTimer);
  }

  buildSkeleton() {
    const { contentEl } = this;
    // Side-by-side layout: the chat column (everything below) plus an
    // optional notes panel (created on demand at contentEl level).
    const main = contentEl.createDiv({ cls: "oc-main" });
    const header = main.createDiv({ cls: "oc-header" });
    const titleRow = header.createDiv({ cls: "oc-header-row" });
    this.backButton = titleRow.createEl("button", {
      cls: "oc-icon-button oc-back",
      attr: { "aria-label": "Back to sessions" },
    });
    setIcon(this.backButton, "arrow-left");
    this.backButton.addEventListener("click", () => this.plugin.activateView());
    this.titleEl = titleRow.createEl("span", { cls: "oc-title", text: this.sessionId });
    // Connector chip: shown when this chat does not belong to the default
    // connector (e.g. a remote OpenCode server).
    this.connectorChipEl = titleRow.createSpan({ cls: "oc-connector-chip", text: "" });
    this.connectorChipEl.style.display = "none";
    this.badgeEl = titleRow.createSpan({
      cls: "opencode-sessions-badge opencode-sessions-badge-none",
      text: "",
    });
    // Action block, anchored to the right edge of the header row:
    // <Copy ID> <Refresh (icon)> <Notes (icon)>.
    const headerActions = titleRow.createDiv({ cls: "oc-header-actions" });
    this.copyButton = headerActions.createEl("button", { cls: "oc-icon-button", text: "Copy ID" });
    this.copyButton.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.sessionId)
        .then(() => new Notice("Copied session ID"))
        .catch(() => new Notice(this.sessionId));
    });
    this.refreshButton = headerActions.createEl("button", {
      cls: "oc-icon-button oc-refresh",
      attr: { "aria-label": "Refresh", title: "Refresh" },
    });
    setIcon(this.refreshButton, "rotate-cw");
    this.refreshButton.addEventListener("click", () => this.refresh(true));
    this.notesButton = headerActions.createEl("button", {
      cls: "oc-icon-button oc-notes-toggle",
      attr: { "aria-label": "Session notes" },
    });
    setIcon(this.notesButton, "sticky-note");
    this.notesButton.style.display = "none";
    this.notesButton.addEventListener("click", () => this.toggleNotes());
    this.metaEl = header.createDiv({ cls: "oc-meta", text: "Loading…" });
    this.offlineEl = header.createDiv({ cls: "oc-offline", text: "" });
    this.offlineEl.style.display = "none";

    // External note edits (made in the editor or another pane) sync into an
    // open notes panel — but never clobber text being typed or a pending save.
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.syncNoteFromOutside(file)),
    );
    // The panel may have opened before the metadata index finished (startup
    // restore) or the note may appear later (created elsewhere) — re-resolve
    // when the index catches up. Cheap: guarded to noteless open panels.
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (this.notesOpen && !this.noteFile && !this.unsubscribed) {
          this.loadNote().catch(() => {});
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", () => {
        if (this.notesOpen && !this.noteFile && !this.noteSavePending && !this.unsubscribed) {
          this.loadNote().catch(() => {});
        }
      }),
    );

    // The chat trick: column-reverse keeps content attached to the bottom.
    // Newest message = FIRST DOM child (visual bottom); scrollTop 0 is the
    // bottom, so streaming growth stays pinned to the latest content without
    // any scroll juggling. "Load older" sits LAST (visual top).
    this.chatEl = main.createDiv({ cls: "oc-chat" });
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
    this.permissionEl = main.createDiv({ cls: "oc-permission" });
    this.permissionEl.style.display = "none";

    // Agent question banner: same placement rationale — the session is
    // paused until the batch is answered or dismissed.
    this.questionEl = main.createDiv({ cls: "oc-question" });
    this.questionEl.style.display = "none";

    const composer = main.createDiv({ cls: "oc-composer" });
    const caps = this.driverCapabilities();
    this.readOnly = !caps.chat;
    if (this.readOnly) {
      // Read-only connectors (file backends): no composer, just a notice.
      composer.addClass("oc-composer-readonly");
      composer.createDiv({
        cls: "oc-readonly-note",
        text: "Read-only connector — this view shows recorded history; prompting applies to OpenCode connectors.",
      });
      this.inputEl = composer.createEl("textarea", { cls: "oc-input", attr: { rows: "1" } });
      this.inputEl.style.display = "none";
      this.inputEl.disabled = true;
      const actions = composer.createDiv({ cls: "oc-composer-actions" });
      this.agentSelect = actions.createEl("select", { cls: "oc-agent-select" });
      this.agentSelect.style.display = "none";
      this.modelSelect = actions.createEl("select", { cls: "oc-model-select" });
      this.modelSelect.style.display = "none";
      this.hintEl = actions.createSpan({ cls: "oc-hint", text: "" });
      this.stopButton = actions.createEl("button", { cls: "oc-stop", text: "Stop" });
      this.stopButton.style.display = "none";
      this.sendButton = actions.createEl("button", { cls: "oc-send", text: "Send" });
      this.sendButton.style.display = "none";
      this.updateComposer();
      return;
    }
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
    this.agentSelect = actions.createEl("select", { cls: "oc-agent-select" });
    this.agentSelect.title = "Agent";
    this.agentSelect.addEventListener("change", () => this.onAgentChange());
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
    const detail = this.driver instanceof FileConnectorDriver
      ? `Could not read this session's transcript${reason ? ` — ${reason}` : ""}. It may have been moved, deleted, or is too large; retrying.`
      : this.driver instanceof OpenCode1Driver
        ? `Could not read the v1 database${reason ? ` — ${reason}` : ""}. Check the connector's database path and sqlite3 setting.`
        : `Server unreachable${reason ? ` — ${reason}` : ""}`;
    const hasDbFallback = typeof this.driver?.databaseUsable === "function" && this.driver.databaseUsable();
    this.offlineEl.setText(
      offline
        ? hasDbFallback
          ? `${detail}. Showing messages from the local database (read-only).`
          : `${detail}.`
        : "",
    );
    this.offlineEl.style.display = offline ? "" : "none";
    this.updateComposer();
  }

  updateComposer() {
    if (this.readOnly) {
      if (this.hintEl) {
        this.hintEl.setText(
          this.driver instanceof FileConnectorDriver
            ? `History from ${this.connector?.name || "this connector"} — refreshed every few seconds`
            : "Read-only — input is unavailable for this connector",
        );
      }
      return;
    }
    const connected = this.driver?.streamConnected() || false;
    this.sendButton.disabled = !!this.offline || !this.inputEl?.value?.trim();
    this.stopButton.disabled = !!this.offline || !this.busy;
    this.stopButton.style.display = "";
    if (this.offline) {
      this.hintEl.setText("Offline — input disabled");
    } else if (this.pendingPermission) {
      this.hintEl.setText("Waiting for your approval — the session is paused");
    } else if (this.pendingQuestion) {
      this.hintEl.setText("Waiting for your answer — the session is paused");
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
    const live = this.driver?.getLiveState(this.sessionId) || null;
    let state;
    if (this.pendingPermission) {
      state = "waiting";
    } else if (this.pendingQuestion) {
      state = "question";
    } else if (this.busy) {
      state = "running";
    } else if (live) {
      // v2 streams carry terminal states (interrupted/error); a live
      // "running" without local busy tracking reads as idle there. File
      // drivers only report running when a transcript is genuinely active.
      state = this.driver instanceof FileConnectorDriver
        ? live.status || "idle"
        : live.status !== "running"
          ? live.status
          : "idle";
    } else {
      state = "idle";
    }
    this.badgeEl.className = `opencode-sessions-badge opencode-sessions-badge-${state}`;
    this.badgeEl.setText(STATE_LABELS[state] || "");
  }

  renderHeader() {
    this.updateNotesChrome();
    const defaultName = this.plugin.registry?.defaultConnector()?.connector.name;
    const chipName = this.connector && this.connector.name !== defaultName ? this.connector.name : "";
    if (this.connectorChipEl) {
      this.connectorChipEl.setText(chipName ? `via ${chipName}` : "");
      this.connectorChipEl.style.display = chipName ? "" : "none";
    }
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

  // ----- session notes ---------------------------------------------------------

  // Notes attachment is vault-side, so it works for every connector. The
  // toggle exists only for bound sessions (drafts have no id yet).
  updateNotesChrome() {
    if (!this.notesButton) return;
    this.notesButton.style.display = this.sessionId ? "" : "none";
    this.notesButton.classList.toggle("oc-active", this.notesOpen && !!this.noteFile);
    this.notesButton.title = this.noteFile ? this.noteFile.path : "Session notes";
    // Deferred open: notesOpen was set before a session was bound (draft
    // promotion, workspace restore) — build the panel now that there is one.
    if (this.sessionId && this.notesOpen && !this.notesPanelEl && this.contentEl) {
      this.renderNotes();
    }
  }

  toggleNotes() {
    if (this.notesOpen && this.noteSaveTimer) {
      // Flush before tearing the textarea out of the DOM.
      window.clearTimeout(this.noteSaveTimer);
      this.noteSaveTimer = null;
      this.saveNoteNow().catch(() => {});
    }
    this.notesOpen = !this.notesOpen;
    this.renderNotes();
  }

  // Idempotent panel render from current state; async state changes funnel
  // through loadNote() and re-render here. Never rebuilt while the textarea
  // is focused (external sync is guarded), so typing is never clobbered.
  // NOTE: the panel element is created/removed BEFORE updateNotesChrome() —
  // its deferred-open path calls back into renderNotes and relies on
  // notesPanelEl already existing (or notesOpen being false).
  renderNotes() {
    if (!this.notesOpen || !this.sessionId) {
      this.teardownNotesPanel();
      this.updateNotesChrome();
      return;
    }
    if (!this.notesPanelEl) this.notesPanelEl = this.contentEl.createDiv({ cls: "oc-notes" });
    this.updateNotesChrome();
    this.contentEl.addClass("has-notes");
    this.notesPanelEl.empty();
    this.noteArea = null;
    this.noteStatusEl = null;
    const header = this.notesPanelEl.createDiv({ cls: "oc-notes-header" });
    header.createSpan({ cls: "oc-notes-title", text: "Session note" });
    const actions = header.createDiv({ cls: "oc-notes-actions" });
    if (this.noteFile) {
      const openButton = actions.createEl("button", {
        cls: "oc-icon-button",
        attr: { "aria-label": "Open in editor", title: "Open in editor" },
      });
      setIcon(openButton, "arrow-up-right");
      openButton.addEventListener("click", () => this.openNoteInEditor());
    }
    const closeButton = actions.createEl("button", {
      cls: "oc-icon-button",
      attr: { "aria-label": "Close notes" },
    });
    setIcon(closeButton, "x");
    closeButton.addEventListener("click", () => this.toggleNotes());

    if (!this.noteFile) {
      const empty = this.notesPanelEl.createDiv({ cls: "oc-notes-empty" });
      if (this.noteLoadedFor !== this.sessionId) {
        empty.createDiv({ cls: "oc-notes-loading", text: "Looking for a note…" });
        this.loadNote().catch(() => {});
        return;
      }
      empty.createDiv({ text: "No note attached to this session yet." });
      empty.createDiv({
        cls: "oc-notes-empty-hint",
        text: `Creates a markdown file in ${this.plugin.settings.notesDir}/ with this session's id in its frontmatter — a normal vault note, linkable and searchable.`,
      });
      const createButton = empty.createEl("button", { cls: "mod-cta", text: "Create note" });
      createButton.addEventListener("click", () => this.createNote());
      return;
    }

    this.noteArea = this.notesPanelEl.createEl("textarea", {
      cls: "oc-notes-area",
      attr: { placeholder: "Notes for this session… (frontmatter is preserved)", spellcheck: "false" },
    });
    this.noteArea.value = this.noteBody;
    this.noteArea.addEventListener("input", () => this.scheduleNoteSave());
    this.noteStatusEl = this.notesPanelEl.createSpan({
      cls: "oc-notes-status",
      text: this.noteSavePending ? "Edited…" : "",
    });
  }

  teardownNotesPanel() {
    this.notesPanelEl?.remove();
    this.notesPanelEl = null;
    this.noteArea = null;
    this.noteStatusEl = null;
    this.contentEl?.removeClass("has-notes");
  }

  // Resolves the session's note from the frontmatter index. A file whose
  // `session:` frontmatter was removed is no longer attached — treated as
  // missing rather than silently re-attached.
  async loadNote() {
    if (!this.sessionId || this.unsubscribed) return;
    const seq = ++this.noteSeq;
    let file = null;
    let frontmatter = null;
    let body = "";
    const indexed = this.plugin.notes ? this.plugin.notes.find(this.sessionId) : null;
    if (indexed) {
      try {
        const text = await this.app.vault.read(indexed);
        const split = splitNoteFrontmatter(text);
        if (split) {
          file = indexed;
          frontmatter = split.frontmatter;
          body = split.body;
        }
      } catch {
        // Unreadable note behaves like a missing one; next open retries.
      }
    }
    if (seq !== this.noteSeq || this.unsubscribed) return;
    this.noteFile = file;
    this.noteFrontmatter = frontmatter;
    this.noteBody = body;
    this.noteLoadedFor = this.sessionId;
    this.renderNotes();
  }

  async createNote() {
    if (!this.sessionId || !this.plugin.notes) return;
    try {
      await this.plugin.notes.ensureNote(this.sessionId, {
        title: this.session?.title || this.titleEl?.getText() || "",
        connectorName: this.connector?.name || "",
      });
      this.noteLoadedFor = null;
      await this.loadNote();
      this.noteArea?.focus();
    } catch (error) {
      new Notice(`Could not create note: ${error.message}`);
    }
  }

  scheduleNoteSave() {
    this.noteSavePending = true;
    if (this.noteStatusEl) this.noteStatusEl.setText("Edited…");
    if (this.noteSaveTimer) window.clearTimeout(this.noteSaveTimer);
    this.noteSaveTimer = window.setTimeout(() => {
      this.noteSaveTimer = null;
      this.saveNoteNow().catch(() => {});
    }, NOTES_SAVE_DEBOUNCE_MS);
  }

  // Rewrites the file with the ORIGINAL frontmatter block (user-added
  // properties survive) and the edited body.
  async saveNoteNow() {
    if (!this.noteFile || !this.noteArea || !this.noteSavePending || !this.noteFrontmatter) return;
    const content = `---\n${this.noteFrontmatter}\n---\n${this.noteArea.value}`;
    if (this.noteStatusEl) this.noteStatusEl.setText("Saving…");
    try {
      await this.app.vault.modify(this.noteFile, content);
      this.noteSavePending = false;
      this.noteBody = this.noteArea.value;
      if (this.noteStatusEl) this.noteStatusEl.setText("Saved");
    } catch (error) {
      if (this.noteStatusEl) this.noteStatusEl.setText(`Save failed: ${error.message}`);
    }
  }

  // External edits (editor, another pane) sync into an open panel — but
  // never clobber typing or a pending autosave of our own.
  syncNoteFromOutside(file) {
    if (!this.notesOpen || this.unsubscribed) return;
    if (this.noteSavePending || document.activeElement === this.noteArea) return;
    if (file !== this.noteFile) return;
    this.loadNote().catch(() => {});
  }

  // Called by the plugin after the notes index is (re)built — a panel that
  // rendered before the index was warm must not sit on a false "no note".
  refreshNoteBinding() {
    if (!this.unsubscribed && this.notesOpen && !this.noteFile && !this.noteSavePending) {
      this.loadNote().catch(() => {});
    }
  }

  async openNoteInEditor() {
    if (!this.noteFile) return;
    const leaf = this.app.workspace.getLeaf("split");
    await leaf.openFile(this.noteFile);
  }

  async loadInitial() {
    const seq = ++this.loadSeq;
    try {
      const [session, messagesResponse] = await Promise.all([
        this.driver.getSession(this.sessionId),
        // Newest page first: order=desc guarantees the latest messages are
        // included even in long sessions (order=asc&limit returns the
        // OLDEST page — sessions over the limit lose their tail).
        this.driver.listMessages(this.sessionId, { limit: DEFAULT_MESSAGE_PAGE, order: "desc" }),
      ]);
      if (this.unsubscribed || seq !== this.loadSeq) return;
      this.setOffline(false);
      this.session = session;
      this.resetMessages();
      this.appendMessages(
        [...(messagesResponse?.data || [])].reverse(),
        messagesResponse?.cursor?.next || null,
      );
      // If the session is already running (view opened mid-stream), adopt it.
      const live = this.driver.getLiveState(this.sessionId);
      this.setBusy(live?.status === "running" || live?.status === "waiting");
      this.renderHeader();
      this.renderBadge();
      this.lastLoadedAt = Date.now();
      this.loadModels().catch(() => {});
      this.loadAgents().catch(() => {});
      this.refreshPendingPermission().catch(() => {});
      this.refreshPendingQuestion().catch(() => {});
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
    if (!this.modelSelect || !this.driverCapabilities().models) return;
    const directory = this.session?.location?.directory || this.draftDirectory;
    let models = [];
    let defaultRef = null;
    try {
      const [listResponse, resolvedDefault] = await Promise.all([
        this.driver.client.models(directory),
        this.plugin.resolveDefaultModel(directory, this.driver),
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
      await this.driver.client.setSessionModel(this.sessionId, ref);
      this.session = { ...this.session, model: ref };
      this.renderHeader();
      new Notice(`Model switched to ${ref.id}${ref.variant ? ` (${ref.variant})` : ""}`);
    } catch (error) {
      new Notice(`Could not switch model: ${error.message}`);
      this.selectModelRef(current || null, null);
    }
  }

  // ----- agent selector ------------------------------------------------------

  selectedAgentId() {
    const value = this.agentSelect?.value || "";
    // The empty value is the Default entry — it lets the server resolve its
    // own default agent (default_agent config → build), like OpenCode itself.
    return value || null;
  }

  // Populates the agent dropdown: a Default entry resolved by the server at
  // prompt time, then every chatty agent for this location. Hidden and
  // subagent-only entries are skipped — they are internal machinery
  // (compaction/title/summary) or invoked via the task tool, not runnable as
  // the session agent.
  async loadAgents() {
    if (!this.agentSelect || !this.driverCapabilities().agents) return;
    const directory = this.session?.location?.directory || this.draftDirectory;
    let agents = [];
    try {
      const response = await this.driver.client.agents(directory);
      agents = Array.isArray(response?.data) ? response.data : [];
    } catch {
      this.agentSelect.style.display = "none";
      return;
    }
    if (this.unsubscribed) return;
    const select = this.agentSelect;
    select.empty();

    const defaultOption = select.createEl("option", { value: "", text: "Default agent" });
    defaultOption.dataset.isDefault = "1";

    for (const agent of agents) {
      if (!agent?.id || agent.hidden || agent.mode === "subagent") continue;
      const option = select.createEl("option", {
        value: agent.id,
        text: agent.name || agent.id,
      });
      if (agent.description) option.title = agent.description;
    }

    // Reflect the session's current agent (existing sessions), else keep the
    // Default entry selected so drafts match the server's default agent.
    const current = this.session?.agent || "";
    if (current) this.selectAgentId(current);
    else select.value = defaultOption.value;
    select.style.display = "";
  }

  selectAgentId(agentId) {
    const select = this.agentSelect;
    if (!select || !agentId) return;
    let match = null;
    for (const option of select.options) {
      if (option.value === agentId) {
        match = option;
        break;
      }
    }
    if (!match) {
      // Agent no longer registered (config changed) — keep it selectable.
      match = select.createEl("option", { value: agentId, text: agentId });
    }
    select.value = match.value;
  }

  async onAgentChange() {
    if (this.isDraft()) return; // stored in the select; applied at creation
    const agentId = this.selectedAgentId();
    if (!agentId || !this.sessionId) return;
    if (this.session?.agent === agentId) return;
    const label = this.agentSelect.selectedOptions[0]?.textContent || agentId;
    try {
      await this.driver.client.setSessionAgent(this.sessionId, agentId);
    } catch (error) {
      new Notice(`Could not switch agent: ${error.message}`);
      this.selectAgentId(this.session?.agent || "");
      return;
    }
    this.session = { ...this.session, agent: agentId };
    this.renderHeader();
    new Notice(`Agent switched to ${label}`);
    // Agents carry their own default model; the server may have swapped it
    // — re-sync the session so the model selector stays truthful.
    try {
      const session = await this.driver.getSession(this.sessionId);
      if (!this.unsubscribed && session) {
        this.session = session;
        this.renderHeader();
        if (session.model) this.selectModelRef(session.model, null);
      }
    } catch {
      // switching worked; the resync is best-effort
    }
  }

  // Manual + automatic refresh entry points (header button, tab focus,
  // stream reconnect, layout-ready). Full reload when idle; non-destructive
  // upsert when streaming so live deltas are not clobbered.
  async refresh(manual = false) {
    if (!this.sessionId || !this.driver || this.refreshing || this.unsubscribed) return;
    if (this.isDraft()) return;
    if (this.busy && !manual) {
      await this.reconcileNow();
      return;
    }
    this.refreshing = true;
    if (this.refreshButton) {
      this.refreshButton.disabled = true;
      this.refreshButton.addClass("oc-busy");
    }
    try {
      await this.loadInitial();
    } finally {
      this.refreshing = false;
      if (this.refreshButton) {
        this.refreshButton.disabled = false;
        this.refreshButton.removeClass("oc-busy");
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

  // Offline fallback: session row + messages straight from SQLite
  // (OpenCode v2 connectors only; file backends surface the load error).
  async loadFromDb() {
    if (typeof this.driver?.loadMessagesFromDb !== "function") {
      this.metaEl.setText("Could not load session — this connector has no offline fallback.");
      return;
    }
    try {
      const row = await this.driver.loadSessionFromDb(this.sessionId);
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
      const messages = await this.driver.loadMessagesFromDb(this.sessionId);
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
      const metaParts = [msg.agent || "assistant"];
      if (msg.model) metaParts.push(modelLabel(msg.model));
      const timeLabel = formatTime(msg.time?.created || msg.time?.streamed);
      if (timeLabel) metaParts.push(timeLabel);
      meta.setText(metaParts.join(" · "));
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
      case "permission.v2.asked": // next-gen servers renamed the event
        this.setPendingPermission(data);
        break;
      case "permission.replied":
      case "permission.v2.replied":
        // Covers replies made anywhere (this banner, the TUI, elsewhere).
        this.clearPendingPermission(data?.requestID);
        break;
      case "form.created":
        // Servers with the form API surface the question tool as a form;
        // newer servers emit question.v2.* events instead.
        this.setPendingQuestion(this.driver?.client?.normalizeForms({ data: [data.form] })[0] || null);
        break;
      case "form.replied":
      case "form.cancelled":
        this.clearPendingQuestion(data?.id);
        break;
      case "question.v2.asked":
        this.setPendingQuestion(this.driver?.client?.normalizeQuestionRequests({ data: [data] })[0] || null);
        break;
      case "question.v2.replied":
      case "question.v2.rejected":
        this.clearPendingQuestion(data?.requestID);
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
    if (!this.sessionId || !this.driver || this.offline) return;
    if (!this.driverCapabilities().permissions) return;
    try {
      const response = await this.driver.client.sessionPermissions(this.sessionId);
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
      await this.driver.client.replyPermission(this.sessionId, pending.id, reply);
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

  // ----- question handling ----------------------------------------------------

  setPendingQuestion(pending) {
    if (!pending?.id || !this.sessionId) return;
    if (pending.sessionID && pending.sessionID !== this.sessionId) return;
    // Same batch already rendered: re-rendering would steal focus from the
    // custom-answer inputs and wipe typed-but-unapplied multi-select text.
    if (this.pendingQuestion?.id === pending.id) return;
    this.pendingQuestion = pending;
    this.renderQuestionBanner();
    this.renderBadge();
    this.updateComposer();
  }

  clearPendingQuestion(questionId) {
    if (!this.pendingQuestion) return;
    if (questionId && this.pendingQuestion.id !== questionId) return;
    this.pendingQuestion = null;
    this.questionAnswers.clear();
    this.questionOptionButtons = null;
    this.questionCustomEls = null;
    this.questionSubmitButton = null;
    // The batch is gone — a stale driver-side "question" state (answer made
    // elsewhere while the event stream was down) must not outlive it.
    this.driver?.clearLiveStatus?.(this.sessionId, "question");
    this.renderQuestionBanner();
    this.renderBadge();
    this.updateComposer();
  }

  // Recovers a pending question batch on view open / refresh (a session
  // that was already waiting, or an answer made while reconnecting).
  async refreshPendingQuestion() {
    if (!this.sessionId || this.offline || !this.driver) return;
    if (!this.driverCapabilities().questions) return;
    try {
      const pending = (await this.driver.client.pendingQuestions(this.sessionId))[0] || null;
      if (this.unsubscribed) return;
      if (pending) {
        this.setPendingQuestion(pending);
      } else if (this.pendingQuestion) {
        this.clearPendingQuestion();
      }
    } catch {
      // server hiccup — the event stream keeps us informed anyway
    }
  }

  renderQuestionBanner() {
    const banner = this.questionEl;
    if (!banner) return;
    banner.empty();
    if (!this.pendingQuestion) {
      banner.style.display = "none";
      return;
    }
    const { title, questions } = this.pendingQuestion;
    banner.style.display = "";
    const head = banner.createDiv({ cls: "oc-question-head" });
    setIcon(head.createSpan({ cls: "oc-question-icon" }), "help-circle");
    head.createSpan({
      cls: "oc-question-title",
      text: title && title !== "Questions" ? `Agent asks — ${title}` : "Agent asks — answer to continue",
    });
    this.questionOptionButtons = new Map();
    this.questionCustomEls = new Map();
    for (const question of questions) {
      this.renderQuestionField(banner, question);
    }
    const actions = banner.createDiv({ cls: "oc-question-actions" });
    const dismiss = actions.createEl("button", { cls: "oc-question-dismiss", text: "Dismiss" });
    dismiss.title = "Reject the questions — the tool call fails and the session continues";
    dismiss.addEventListener("click", () => this.dismissQuestion());
    this.questionSubmitButton = actions.createEl("button", {
      cls: "oc-question-submit",
      text: questions.length > 1 ? `Submit ${questions.length} answers` : "Submit answer",
    });
    this.questionSubmitButton.addEventListener("click", () => this.submitQuestion());
    this.refreshQuestionSelections();
    this.updateQuestionSubmitState();
  }

  renderQuestionField(banner, question) {
    const field = banner.createDiv({ cls: "oc-question-field" });
    field.createDiv({ cls: "oc-question-header", text: question.header });
    if (question.question) {
      field.createDiv({ cls: "oc-question-text", text: question.question });
    }
    if (question.external) {
      field.createDiv({
        cls: "oc-question-external",
        text: "This input is answered from another surface; Submit acknowledges it here, Dismiss cancels.",
      });
      return;
    }
    const answered = () => this.questionAnswers.get(question.key);
    const setAnswer = (value) => {
      this.questionAnswers.set(question.key, value);
      this.refreshQuestionSelections();
      this.updateQuestionSubmitState();
    };
    if (question.boolean) {
      const row = field.createDiv({ cls: "oc-question-options" });
      for (const value of [true, false]) {
        const option = row.createEl("button", {
          cls: "oc-question-option",
          text: value ? "Yes" : "No",
        });
        this.trackQuestionOption(question.key, option, value);
        option.addEventListener("click", () => setAnswer(value));
      }
      return;
    }
    const choices = Array.isArray(question.options) ? question.options : [];
    if (choices.length) {
      const row = field.createDiv({ cls: "oc-question-options" });
      for (const choice of choices) {
        const option = row.createEl("button", { cls: "oc-question-option" });
        option.createSpan({ cls: "oc-question-option-label", text: choice.label });
        if (choice.description) {
          option.createSpan({ cls: "oc-question-option-desc", text: choice.description });
        }
        const value = choice.value ?? choice.label;
        this.trackQuestionOption(question.key, option, value);
        option.addEventListener("click", () => {
          if (question.multiple) {
            const current = new Set(Array.isArray(answered()) ? answered() : []);
            if (current.has(value)) current.delete(value);
            else current.add(value);
            this.questionAnswers.set(question.key, [...current]);
          } else {
            this.questionAnswers.set(question.key, value);
          }
          const custom = this.questionCustomEls?.get(question.key);
          if (custom) custom.value = "";
          this.refreshQuestionSelections();
          this.updateQuestionSubmitState();
        });
      }
    }
    if (!choices.length || question.custom !== false) {
      const custom = field.createEl("input", {
        type: "text",
        cls: "oc-question-custom",
        attr: {
          placeholder: question.multiple
            ? "Add your own answer (Enter to add)…"
            : "Or type your own answer…",
          spellcheck: "false",
        },
      });
      const current = answered();
      custom.value = Array.isArray(current) ? "" : typeof current === "string" ? current : "";
      this.questionCustomEls.set(question.key, custom);
      const applyCustom = () => {
        const text = custom.value.trim();
        if (!text) return;
        if (question.multiple) {
          const currentSet = new Set(Array.isArray(answered()) ? answered() : []);
          currentSet.add(text);
          this.questionAnswers.set(question.key, [...currentSet]);
          custom.value = "";
        } else {
          this.setCustomAnswer(question, text);
        }
        this.refreshQuestionSelections();
        this.updateQuestionSubmitState();
      };
      custom.addEventListener("input", () => {
        // Typing overrides a picked option for single-choice fields.
        const text = custom.value.trim();
        if (text && !question.multiple) {
          this.setCustomAnswer(question, text);
          this.refreshQuestionSelections();
          this.updateQuestionSubmitState();
        }
      });
      custom.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          applyCustom();
        }
      });
    }
  }

  trackQuestionOption(key, el, value) {
    if (!this.questionOptionButtons) return;
    let entries = this.questionOptionButtons.get(key);
    if (!entries) {
      entries = [];
      this.questionOptionButtons.set(key, entries);
    }
    entries.push({ el, value });
  }

  // Free-text answers: numeric fields only accept finite numbers — anything
  // else leaves the field unanswered (Submit stays disabled) instead of
  // serializing NaN → null into the reply.
  setCustomAnswer(question, text) {
    if (!question.numeric) {
      this.questionAnswers.set(question.key, text);
      return;
    }
    const numeric = Number(text);
    this.questionAnswers.set(question.key, Number.isFinite(numeric) ? numeric : undefined);
  }

  // Toggles .is-selected in place — selection changes must not re-render
  // the banner (that would steal focus from the custom-answer inputs).
  refreshQuestionSelections() {
    if (!this.questionOptionButtons) return;
    for (const [key, entries] of this.questionOptionButtons) {
      const value = this.questionAnswers.get(key);
      const selected = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        entry.el.classList.toggle("is-selected", selected.includes(entry.value));
      }
    }
  }

  questionFieldAnswered(question) {
    const value = this.questionAnswers.get(question.key);
    if (question.boolean) return value === true || value === false;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && String(value).trim() !== "";
  }

  updateQuestionSubmitState() {
    if (!this.questionSubmitButton || !this.pendingQuestion) return;
    const complete = this.pendingQuestion.questions
      .filter((question) => !question.external)
      .every((question) => this.questionFieldAnswered(question));
    this.questionSubmitButton.disabled = !complete;
  }

  async submitQuestion() {
    const pending = this.pendingQuestion;
    if (!pending || this.replyingQuestion) return;
    this.replyingQuestion = true;
    if (this.questionSubmitButton) this.questionSubmitButton.disabled = true;
    try {
      await this.driver.client.replyPendingQuestions(this.sessionId, pending, this.questionAnswers);
      this.clearPendingQuestion(pending.id);
      new Notice("Answer sent — the session continues");
    } catch (error) {
      // Answered or dismissed elsewhere (TUI, another tab): 404/409 — clear.
      if (/^40[49]/.test(String(error.message))) {
        this.clearPendingQuestion(pending.id);
      } else {
        new Notice(`Answer failed: ${error.message}`);
      }
    } finally {
      this.replyingQuestion = false;
      // Re-enable Submit for a retry — a transient failure must not leave
      // the banner permanently unanswerable while the session is paused.
      this.updateQuestionSubmitState();
    }
  }

  async dismissQuestion() {
    const pending = this.pendingQuestion;
    if (!pending || this.replyingQuestion) return;
    this.replyingQuestion = true;
    try {
      await this.driver.client.dismissPendingQuestions(this.sessionId, pending);
      this.clearPendingQuestion(pending.id);
      new Notice("Questions dismissed — the tool call was rejected");
    } catch (error) {
      if (/^40[49]/.test(String(error.message))) {
        this.clearPendingQuestion(pending.id);
      } else {
        new Notice(`Dismiss failed: ${error.message}`);
      }
    } finally {
      this.replyingQuestion = false;
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
    if (this.unsubscribed || !this.sessionId || !this.driver || this.isDraft()) return;
    // v2 skips reconciling while the server is known-down (events will
    // recover it); file drivers keep retrying — reads are local and cheap.
    if (this.driver instanceof OpenCode2Driver && this.offline) return;
    try {
      // Cap the reconcile window: catching new tail messages does not
      // require re-fetching unbounded history every few seconds.
      const limit = Math.min(Math.max(DEFAULT_MESSAGE_PAGE, this.messages.size), 300);
      const response = await this.driver.listMessages(this.sessionId, { limit, order: "desc" });
      if (this.unsubscribed) return;
      for (const message of [...(response?.data || [])].reverse()) {
        this.upsertMessage(message);
      }
      const session = await this.driver.getSession(this.sessionId).catch(() => null);
      if (!this.unsubscribed && session) {
        this.session = session;
        this.renderHeader();
      }
      this.lastLoadedAt = Date.now();
      if (this.offline) this.setOffline(false);
      if (this.driverCapabilities().permissions) {
        this.refreshPendingPermission().catch(() => {});
        this.refreshPendingQuestion().catch(() => {});
      }
    } catch {
      // ignore — the next event or manual refresh will retry
    }
  }

  async loadOlder() {
    if (this.loadingOlder || !this.cursorOlder || this.offline || !this.driver) return;
    this.loadingOlder = true;
    this.olderButton.setText("Loading…");
    const chat = this.chatEl;
    const beforeHeight = chat.scrollHeight;
    const beforeTop = chat.scrollTop;
    try {
      // Cursor-only request (cursors must not combine with order); pages
      // continue toward older messages in newest→oldest order. File
      // connectors use synthetic offset cursors over the parsed transcript.
      const response = await this.driver.listMessages(this.sessionId, {
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
    if (this.offline || !this.driver) return;
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
      const response = await this.driver.client.prompt(this.sessionId, text);
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
      const created = await this.driver.client.request("/api/session", {
        method: "POST",
        body: {
          location: { directory: this.draftDirectory },
          model: this.selectedModelRef() || undefined,
          agent: this.selectedAgentId() || undefined,
        },
      });
      const session = created?.data;
      if (!session?.id) throw new Error("server returned no session id");
      this.draftDirectory = null;
      this.session = session;
      this.bindSession(session.id);
      this.renderHeader();
      this.renderBadge();
      // The server resolved the default agent at creation — show it.
      this.selectAgentId(session.agent || "");
      this.inputEl.value = "";
      this.autoGrow();
      const response = await this.driver.client.prompt(session.id, text);
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
    if (this.offline || !this.sessionId || !this.driver) return;
    try {
      const response = await this.driver.client.interrupt(this.sessionId);
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
    this.connectorId = plugin.pendingPickerConnectorId || null;
    plugin.pendingPickerDirectories = null;
    plugin.pendingPickerConnectorId = null;
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

  setDirectories(directories, connectorId = null) {
    this.directories = directories;
    this.connectorId = connectorId;
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
      card.addEventListener("click", () => this.plugin.openSessionDraft(directory, this.connectorId));
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
    this.connectorTimers = new Map();
  }

  clearConnectorTimers() {
    for (const timer of this.connectorTimers.values()) window.clearInterval(timer);
    this.connectorTimers.clear();
  }

  hide() {
    this.clearConnectorTimers();
    if (super.hide) super.hide();
  }

  display() {
    const { containerEl } = this;
    this.clearConnectorTimers();
    containerEl.empty();

    this.renderGlobalSection(containerEl);
    new Setting(containerEl).setName("Connectors").setHeading();
    for (const connector of this.plugin.settings.connectors) {
      this.renderConnectorCard(containerEl, connector);
    }
    this.renderAddConnector(containerEl);
  }

  renderGlobalSection(containerEl) {
    const registry = this.plugin.registry;
    const entries = registry.all();
    const defaultEntry = registry.defaultConnector();
    new Setting(containerEl)
      .setName("Default connector")
      .setDesc(
        "Used by dashboards and chats that do not name a connector. Falls back to the first enabled connector.",
      )
      .addDropdown((dropdown) => {
        for (const { connector } of entries) {
          dropdown.addOption(connector.id, `${connector.name} — ${CONNECTOR_KINDS[connector.kind]?.label || connector.kind}`);
        }
        if (!entries.length) dropdown.addOption("", "No connectors");
        dropdown.setValue(defaultEntry?.connector.id || "");
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultConnectorId = value;
          await this.plugin.saveSettings();
        });
      });

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
      .setName("Session notes folder")
      .setDesc(
        "Vault folder for per-session notes (toggled from a chat's header). Notes are ordinary markdown files attached by a session: frontmatter id — rename or move them freely. Empty restores vibed-notes.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_NOTES_DIR)
          .setValue(this.plugin.settings.notesDir)
          .onChange(async (value) => {
            this.plugin.settings.notesDir = normalizeNotesDir(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Open dashboard")
      .setDesc("Open the sessions table in a new Obsidian tab.")
      .addButton((button) => button.setButtonText("Open").onClick(() => this.plugin.activateView()));
  }

  renderConnectorCard(containerEl, connector) {
    const plugin = this.plugin;
    const card = containerEl.createDiv({ cls: "opencode-connector-card" });
    const head = card.createDiv({ cls: "opencode-connector-card-head" });
    head.createSpan({
      cls: "opencode-connector-kind",
      text: `${CONNECTOR_KINDS[connector.kind]?.label || connector.kind}${connector.id === plugin.settings.defaultConnectorId ? " · default" : ""}`,
    });

    const nameInput = head.createEl("input", {
      type: "text",
      cls: "opencode-connector-name",
      attr: { spellcheck: "false" },
    });
    nameInput.value = connector.name;
    nameInput.addEventListener("change", async () => {
      const value = nameInput.value.trim();
      const taken = plugin.settings.connectors.some((c) => c.id !== connector.id && c.name === value);
      if (!isValidConnectorName(value) || taken) {
        new Notice(
          taken ? `Name "${value}" is already used by another connector.` : "Connector names must be non-empty and cannot contain ':'.",
        );
        nameInput.value = connector.name;
        return;
      }
      connector.name = value;
      await plugin.saveSettings();
    });

    const entry = plugin.registry.get(connector.id);
    const driver = entry?.driver || null;

    let caps = {};
    try {
      caps = driver?.capabilities() || {};
    } catch {
      caps = {};
    }
    if (caps.chat) {
      head.createSpan({ cls: "opencode-connector-badge", text: "interactive · live" });
    } else {
      head.createSpan({
        cls: "opencode-connector-badge opencode-connector-badge-readonly",
        text: caps.live === "none" ? "read-only · historical" : "read-only",
      });
    }

    const toggleWrap = head.createDiv({ cls: "opencode-connector-toggle" });
    const toggleLabel = toggleWrap.createSpan({ text: "Enabled", cls: "opencode-connector-toggle-label" });
    const toggle = toggleWrap.createEl("input", { type: "checkbox" });
    toggle.checked = connector.enabled;
    toggle.addEventListener("change", async () => {
      connector.enabled = toggle.checked;
      // Start/stop the live connection so disabled connectors go quiet.
      plugin.registry.get(connector.id)?.driver.setActive(toggle.checked);
      await plugin.saveSettings();
    });
    toggleLabel.addEventListener("click", () => {
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event("change"));
    });

    head.createEl("button", { text: "Duplicate" }).addEventListener("click", async () => {
      await plugin.duplicateConnector(connector.id);
      this.display();
    });
    head.createEl("button", { text: "Delete" }).addEventListener("click", async () => {
      await plugin.removeConnector(connector.id);
      this.display();
    });

    const statusEl = card.createDiv({ cls: "opencode-sessions-status", text: "Checking…" });
    const refreshStatus = async () => {
      const currentDriver = plugin.registry.get(connector.id)?.driver;
      if (!currentDriver) {
        statusEl.setText("Connector not running.");
        return;
      }
      try {
        const health = await currentDriver.health();
        if (health && health.ok === false) {
          statusEl.setText(`Problem — ${health.detail || "connector is not usable"}.`);
        } else {
          const detail = health?.detail || "";
          let endpointLine = "";
          if (currentDriver instanceof OpenCode2Driver) {
            const endpoint = currentDriver.client.endpoint;
            const overrideMark = endpoint?.override ? " (override)" : "";
            const dbUsable = typeof currentDriver.databaseUsable === "function" && currentDriver.databaseUsable();
            endpointLine = `${endpoint ? ` to ${endpoint.baseUrl}` : ""}${overrideMark} — ${detail}. Event stream: ${currentDriver.streamConnected() ? "live" : "connecting…"}. Listing: ${dbUsable ? "SQLite" : "API"}.`;
          } else {
            endpointLine = ` — ${detail}. Read-only; refreshed on interval.`;
          }
          statusEl.setText(`Connected${endpointLine}`);
        }
      } catch {
        statusEl.setText(
          typeof currentDriver.databaseUsable === "function" && currentDriver.databaseUsable()
            ? "Server unreachable — dashboards fall back to SQLite polling; chat and input are disabled until it returns."
            : "Server unreachable — this connector has no local database; listing and chat are unavailable until it returns.",
        );
      }
    };
    refreshStatus();
    this.connectorTimers.set(
      connector.id,
      window.setInterval(() => {
        if (statusEl.isConnected) refreshStatus();
      }, 15000),
    );

    const body = card.createDiv({ cls: "opencode-connector-card-body" });
    if (connector.kind === "opencode2") {
      this.renderOpenCode2Fields(body, connector, driver);
    } else if (connector.kind === "opencode1") {
      this.renderOpenCode1Fields(body, connector);
    } else if (connector.kind === "codex") {
      this.renderFileFields(body, connector, {
        rootKey: "sessionsRoot",
        rootName: "Sessions root",
        rootDesc: "Codex rollout directory (default ~/.codex/sessions).",
        zstd: true,
      });
    } else {
      this.renderFileFields(body, connector, {
        rootKey: "projectsRoot",
        rootName: "Projects root",
        rootDesc:
          connector.kind === "claude-code"
            ? "Claude Code projects directory (default ~/.claude/projects)."
            : "Cursor projects directory (default ~/.cursor/projects).",
        zstd: false,
      });
    }
  }

  renderOpenCode1Fields(containerEl, connector) {
    const plugin = this.plugin;
    const config = connector.config;
    new Setting(containerEl)
      .setName("OpenCode v1 database")
      .setDesc("Read-only SQLite database with the legacy v1 tables (session/message/part). Often the same opencode.db as v2 — both connectors can point at it.")
      .addText((text) =>
        text
          .setValue(config.databasePath)
          .onChange(async (value) => {
            config.databasePath = value.trim();
            await plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("sqlite3 executable")
      .setDesc("Usually just sqlite3, or an absolute path to the executable.")
      .addText((text) =>
        text
          .setValue(config.sqlitePath)
          .onChange(async (value) => {
            config.sqlitePath = value.trim() || defaultSqlitePath();
            await plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Directories")
      .setDesc("One OpenCode working directory per line (historical sessions).")
      .addTextArea((text) => {
        text
          .setValue((config.directories || []).join("\n"))
          .onChange(async (value) => {
            config.directories = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
      });
    new Setting(containerEl)
      .setName("Custom SQL")
      .setDesc("Optional SQL WHERE fragment appended after directory IN (...).")
      .addTextArea((text) => {
        text
          .setPlaceholder("title LIKE '%pipeline%'")
          .setValue(config.customSql || "")
          .onChange(async (value) => {
            config.customSql = value.trim();
            await plugin.saveSettings();
          });
        text.inputEl.rows = 3;
        text.inputEl.style.width = "100%";
      });
  }

  renderFileFields(containerEl, connector, opts) {
    const plugin = this.plugin;
    const config = connector.config;
    new Setting(containerEl)
      .setName(opts.rootName)
      .setDesc(opts.rootDesc)
      .addText((text) =>
        text
          .setValue(config[opts.rootKey] || "")
          .onChange(async (value) => {
            config[opts.rootKey] = value.trim();
            await plugin.saveSettings();
          }),
      );
    if (opts.zstd) {
      new Setting(containerEl)
        .setName("zstd executable")
        .setDesc("Used to read compressed (.jsonl.zst) rollouts. Compressed sessions list normally and decompress when opened; without zstd they fail to open with a clear error.")
        .addText((text) =>
          text
            .setValue(config.zstdPath || "zstd")
            .onChange(async (value) => {
              config.zstdPath = value.trim() || "zstd";
              await plugin.saveSettings();
            }),
        );
    }
    new Setting(containerEl)
      .setName("Directories")
      .setDesc(
        "Optional filter — one project directory per line; empty lists everything. Entries also disambiguate Claude/Cursor's lossy encoded project names.",
      )
      .addTextArea((text) => {
        text
          .setValue((config.directories || []).join("\n"))
          .onChange(async (value) => {
            config.directories = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
      });
  }

  renderOpenCode2Fields(containerEl, connector, driver) {
    const plugin = this.plugin;
    const config = connector.config;

    new Setting(containerEl)
      .setName("Server URL override")
      .setDesc(
        "Leave empty to auto-discover the local server via ~/.local/state/opencode/service.json (recommended). Set a URL (e.g. http://host:49374) for a remote OpenCode v2 server — listing then comes from its API unless the database below is also enabled and reachable.",
      )
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:49374")
          .setValue(config.apiBaseUrl)
          .onChange(async (value) => {
            config.apiBaseUrl = value.trim();
            await plugin.saveSettings();
            driver?.restartConnection();
          }),
      );

    new Setting(containerEl)
      .setName("Server password override")
      .setDesc("Basic-auth password. Leave empty to use the discovered service credentials.")
      .addText((text) =>
        text
          .setValue(config.apiPassword)
          .onChange(async (value) => {
            config.apiPassword = value.trim();
            await plugin.saveSettings();
            driver?.restartConnection();
          }),
      );

    new Setting(containerEl)
      .setName("Use local database (SQLite)")
      .setDesc(
        "List sessions from opencode.db — works even when the server is unreachable. Disable for remote servers whose database is not on this machine; listing then uses the API.",
      )
      .addToggle((toggle) =>
        toggle.setValue(!!config.useDatabase).onChange(async (value) => {
          config.useDatabase = value;
          await plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Directories")
      .setDesc("One OpenCode working directory per line. Add historical aliases if needed.")
      .addTextArea((text) => {
        text
          .setValue(config.directories.join("\n"))
          .onChange(async (value) => {
            config.directories = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = "100%";
      });

    if (!config.useDatabase) {
      const note = containerEl.createDiv({
        cls: "opencode-sessions-status",
        text: "API listing mode: sessions come from the server's /api/session endpoint (custom SQL does not apply).",
      });
      note.style.marginBottom = "0.5rem";
      return;
    }

    new Setting(containerEl)
      .setName("OpenCode database")
      .setDesc("Read-only SQLite database used by OpenCode v2 (session_v2).")
      .addText((text) =>
        text
          .setValue(config.databasePath)
          .onChange(async (value) => {
            config.databasePath = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("sqlite3 executable")
      .setDesc("Usually just sqlite3, or an absolute path to the executable.")
      .addText((text) =>
        text
          .setValue(config.sqlitePath)
          .onChange(async (value) => {
            config.sqlitePath = value.trim() || defaultSqlitePath();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Custom SQL")
      .setDesc("Optional SQL WHERE fragment appended after directory IN (...). Example: title LIKE '%pipeline%'.")
      .addTextArea((text) => {
        text
          .setPlaceholder("title LIKE '%pipeline%'")
          .setValue(config.customSql)
          .onChange(async (value) => {
            config.customSql = value.trim();
            await plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
      });
  }

  renderAddConnector(containerEl) {
    const kindSetting = new Setting(containerEl)
      .setName("Add connector")
      .setDesc("Each connector is a named backend. OpenCode v2 connectors are interactive (chat, models, approvals); OpenCode v1, Claude Code, Codex and Cursor connectors are read-only.");
    let selectedKind = "opencode2";
    kindSetting.addDropdown((dropdown) => {
      for (const kind of Object.values(CONNECTOR_KINDS)) {
        dropdown.addOption(kind.id, kind.label);
      }
      dropdown.setValue(selectedKind);
      dropdown.onChange((value) => {
        selectedKind = value;
      });
    });
    kindSetting.addButton((button) =>
      button.setButtonText("Add").onClick(async () => {
        await this.plugin.addConnector(selectedKind);
        this.display();
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class OpenCodeSessionsPlugin extends Plugin {
  async onload() {
    this.vaultRoot = this.app.vault.adapter?.basePath || "";
    const saved = (await this.loadData()) || {};
    this.settings = normalizeSettings(saved, this.vaultRoot);

    this.listeners = new Set();
    // `${connectorId}:${sessionID}` -> Set<listener(event)> for open chat views.
    this.sessionListeners = new Map();
    this.listRefreshTimer = null;
    this.pendingSessionRef = null;
    this.pendingDraftDirectory = null;
    this.pendingPickerDirectories = null;

    this.registry = new ConnectorRegistry(this);
    this.registry.init();

    // Session notes: index frontmatter `session:` ids over Obsidian's
    // metadata cache. "changed" fires on every cache update (create, edit,
    // frontmatter change) — the index never needs a disk pass after startup.
    this.notes = new SessionNotes(this);
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.notes.indexFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.notes.unindexFile(file)));
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.notes.buildIndex();
        this.refreshNoteBindings();
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.notes.buildIndex();
      this.refreshNoteBindings();
    });

    this.api = {
      apiVersion: 4,
      // Per-connector namespace: api.connector("claude").list({}) …
      connectors: () =>
        this.registry.all().map(({ connector, driver }) => ({
          id: connector.id,
          name: connector.name,
          kind: connector.kind,
          enabled: connector.enabled,
          capabilities: safeCapabilities(driver),
        })),
      defaultConnector: () => this.registry.defaultConnector()?.connector.name || null,
      connector: (name) => {
        const entry = this.registry.byName(name);
        if (!entry) throw new Error(`Unknown connector: ${name}`);
        const driver = entry.driver;
        const requireV2 = () => {
          if (!(driver instanceof OpenCode2Driver)) {
            throw new Error(`Connector "${name}" is read-only (${entry.connector.kind})`);
          }
          return driver;
        };
        return {
          info: () => ({ id: entry.connector.id, name: entry.connector.name, kind: entry.connector.kind, enabled: entry.connector.enabled, capabilities: safeCapabilities(driver) }),
          health: () => driver.health(),
          list: (query = {}) => driver.listSessions({ ...query, connector: name }),
          session: (sessionId) => driver.getSession(sessionId),
          messages: (sessionId, options) => driver.listMessages(sessionId, options),
          prompt: (sessionId, text) => requireV2().client.prompt(sessionId, text),
          stop: (sessionId) => requireV2().client.interrupt(sessionId),
        };
      },
      refresh: async () => {
        const rows = await this.loadSessions();
        this.emitChange();
        return rows;
      },
      subscribe: (listener) => this.subscribe(listener),
      config: () => ({
        databasePath: this.defaultConnectorConfig()?.databasePath,
        directories: [...(this.defaultConnectorConfig()?.directories || [])],
        customSql: this.defaultConnectorConfig()?.customSql || "",
        refreshSeconds: this.settings.refreshSeconds,
        pageSize: this.settings.pageSize,
        server: this.client?.endpoint || null,
        eventsConnected: this.serverEvents?.connected || false,
        connectors: this.registry.all().map(({ connector, driver }) => ({
          id: connector.id,
          name: connector.name,
          kind: connector.kind,
          enabled: connector.enabled,
          capabilities: safeCapabilities(driver),
        })),
        defaultConnector: this.registry.defaultConnector()?.connector.name || null,
      }),
      open: (ref) => this.openSession(ref),
      // Vault-side session notes: find(sessionId) -> { path } | null.
      notes: {
        find: (sessionId) => {
          const file = this.notes?.find(sessionId);
          return file ? { path: file.path, basename: file.basename } : null;
        },
        folder: () => this.settings.notesDir,
      },
      server: {
        connected: () => this.serverEvents?.connected || false,
        health: () => {
          if (!this.client) throw new Error("No OpenCode v2 connector configured");
          return this.client.health();
        },
        session: (sessionId) => {
          if (!this.client) throw new Error("No OpenCode v2 connector configured");
          return this.client.session(sessionId);
        },
        messages: (sessionId, options) => {
          if (!this.client) throw new Error("No OpenCode v2 connector configured");
          return this.client.messages(sessionId, options);
        },
        prompt: (sessionId, text) => {
          if (!this.client) throw new Error("No OpenCode v2 connector configured");
          return this.client.prompt(sessionId, text);
        },
        stop: (sessionId) => {
          if (!this.client) throw new Error("No OpenCode v2 connector configured");
          return this.client.interrupt(sessionId);
        },
      },
    };
    globalThis.vibed = this.api;

    this.registerView(VIEW_TYPE_SESSIONS, (leaf) => new OpenCodeSessionsView(leaf, this));
    this.registerView(VIEW_TYPE_SESSION, (leaf) => new SessionChatView(leaf, this));
    this.registerView(VIEW_TYPE_NEW_SESSION, (leaf) => new NewSessionView(leaf, this));
    // Note-embeddable dashboards: ```vibed blocks render the same
    // dashboard as the view, configured by the block body. A `connector:`
    // option selects a named connector; without it the default is used.
    const blockProcessor = (source, el, ctx) => {
      let options;
      try {
        options = parseBlockConfig(source);
      } catch (error) {
        el.createEl("pre").setText(`vibed error: ${error.message}`);
        return;
      }
      ctx.addChild(new SessionsDashboardChild(el, this, options));
    };
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, blockProcessor);
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
    this.addCommand({
      id: "open-session-by-id",
      name: "Open session by ID",
      callback: () => this.promptForSessionId(),
    });
    // Links from notes: [label](obsidian://vibed?sessionId=ses_…)
    // A `connector` parameter names the connector for non-default backends:
    // [label](obsidian://vibed?connector=claude&sessionId=<uuid>)
    const protocolHandler = (params) => {
      const id = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!id) return;
      const connectorName = typeof params.connector === "string" ? params.connector.trim() : "";
      this.openSession(connectorName ? `${connectorName}:${id}` : id);
    };
    this.registerObsidianProtocolHandler(BLOCK_LANGUAGE, protocolHandler);
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
    this.registry?.dispose();
    this.listeners.clear();
    this.sessionListeners.clear();
    if (globalThis.vibed === this.api) delete globalThis.vibed;
  }

  // Default-connector accessors: the default connector's v2 client / event
  // stream. Views must use their own connector's driver instead of these.
  get client() {
    const driver = this.registry?.defaultConnector()?.driver;
    return driver instanceof OpenCode2Driver ? driver.client : null;
  }

  get serverEvents() {
    const driver = this.registry?.defaultConnector()?.driver;
    return driver instanceof OpenCode2Driver ? driver.stream : null;
  }

  defaultConnectorConfig() {
    return this.registry?.defaultConnector()?.connector.config || null;
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

  // After the notes index is (re)built, open chat panels that rendered
  // against an empty index re-resolve their note binding.
  refreshNoteBindings() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)) {
      const view = leaf.view;
      if (view instanceof SessionChatView) view.refreshNoteBinding();
    }
  }

  // ----- v2 event stream handling -------------------------------------------

  // Entry point for every driver's SSE events; `driver` identifies the
  // connector so multiple OpenCode servers never collide.
  handleServerEvent(event, driver) {
    if (!driver) return;
    const type = String(event.type || "");
    const data = event.data || {};
    if (type === "server.instance.disposed") {
      driver.onServerDisposed();
      return;
    }
    const sessionId = data.sessionID || (type === "form.created" ? data.form?.sessionID : undefined);
    driver.applyLiveEvent(type, sessionId);
    if (!sessionId) return;
    const listeners = this.sessionListeners.get(`${driver.connector.id}:${sessionId}`);
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

  // (2) Stream lost then recovered: SSE deltas in the gap are unrecoverable,
  // so reconcile every open session against the server + refresh the lists.
  async onStreamReconnected(driver) {
    await driver.syncActiveSessions();
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
  async resolveDefaultModel(directory, driver = null) {
    const fromState = this.readModelSelectionState();
    if (fromState) return fromState;
    const client =
      (driver instanceof OpenCode2Driver ? driver.client : null) ||
      (this.registry.defaultConnector()?.driver instanceof OpenCode2Driver
        ? this.registry.defaultConnector().driver.client
        : null);
    if (!client) return null;
    try {
      const response = await client.defaultModel(directory);
      const model = response?.data;
      if (model?.id && model?.providerID) {
        return { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
      }
    } catch {
      // fall through
    }
    return null;
  }


  async saveSettings() {
    await this.saveData(this.settings);
    this.emitChange();
  }

  // ----- connector management (settings tab) ---------------------------------

  async addConnector(kindId) {
    const kind = CONNECTOR_KINDS[kindId] || CONNECTOR_KINDS.opencode2;
    const connector = normalizeConnector({
      id: newConnectorId(),
      kind: kind.id,
      name: generateConnectorName(kind.id, this.settings.connectors.map((c) => c.name)),
      enabled: true,
      config: kind.createConfig(),
    });
    // OpenCode v2 defaults its directories to the vault (listing needs a
    // scope); file backends list everything until directories are set.
    if (connector.kind === "opencode2" && !connector.config.directories.length && this.vaultRoot) {
      connector.config.directories = [this.vaultRoot];
    }
    this.settings.connectors.push(connector);
    if (!this.settings.defaultConnectorId) this.settings.defaultConnectorId = connector.id;
    this.registry.create(connector);
    await this.saveSettings();
    return connector;
  }

  async duplicateConnector(id) {
    const source = this.registry.get(id)?.connector;
    if (!source) return null;
    const copy = normalizeConnector({
      id: newConnectorId(),
      kind: source.kind,
      name: generateConnectorName(source.kind, this.settings.connectors.map((c) => c.name)),
      enabled: source.enabled,
      config: JSON.parse(JSON.stringify(source.config)),
    });
    this.settings.connectors.push(copy);
    this.registry.create(copy);
    await this.saveSettings();
    return copy;
  }

  async removeConnector(id) {
    this.settings.connectors = this.settings.connectors.filter((c) => c.id !== id);
    if (this.settings.defaultConnectorId === id) {
      this.settings.defaultConnectorId = this.settings.connectors[0]?.id || "";
    }
    this.registry.remove(id);
    await this.saveSettings();
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

  // Opens a session chat. Accepts { connectorId, sessionId }, the string
  // "connectorName:sessionId", or a bare session id (default connector).
  async openSession(ref) {
    const { connectorId, sessionId, unknownConnector } = this.resolveSessionRef(ref);
    if (unknownConnector) {
      new Notice(`Unknown connector: ${unknownConnector}`);
      return;
    }
    if (!sessionId) return;
    const entry = this.registry.get(connectorId) || this.registry.defaultConnector();
    if (!entry) {
      new Notice("OpenCode Sessions: no connector configured");
      return;
    }
    const resolvedConnectorId = entry.connector.id;
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_SESSION)
      .find(
        (leaf) =>
          leaf.view instanceof SessionChatView &&
          leaf.view.connectorId === resolvedConnectorId &&
          leaf.view.sessionId === sessionId,
      );
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      // Previously this just revealed a potentially stale tab (missed SSE
      // while elsewhere). Refresh stale/offline content on pick.
      if (existing.view instanceof SessionChatView) {
        existing.view.refreshIfStale().catch(() => {});
      }
      return existing;
    }
    this.pendingSessionRef = { connectorId: resolvedConnectorId, sessionId };
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_SESSION,
      active: true,
      state: { sessionId, connectorId: resolvedConnectorId },
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  // Normalizes any accepted ref form. A bare string without ":" resolves to
  // the default connector; "name:id" resolves the name (errors surface via
  // the returned unknownConnector flag instead of a silent fallback).
  resolveSessionRef(ref) {
    if (ref && typeof ref === "object") {
      return { connectorId: ref.connectorId || null, sessionId: ref.sessionId || null };
    }
    const value = String(ref || "");
    const separator = value.indexOf(":");
    if (separator === -1) {
      return { connectorId: null, sessionId: value || null };
    }
    const name = value.slice(0, separator);
    const sessionId = value.slice(separator + 1) || null;
    const entry = this.registry.byName(name);
    if (!entry) return { connectorId: null, sessionId, unknownConnector: name };
    return { connectorId: entry.connector.id, sessionId };
  }

  // New-session flow: single configured directory goes straight to a draft
  // chat; several open the directory picker. The `connector` option is
  // authoritative end-to-end — directories come from ITS config and the
  // draft is pinned to IT, never silently to the default connector.
  async newSession(options = {}) {
    const entry = this.connectorForOptions(options);
    let draftsCapable = false;
    try {
      draftsCapable = !!entry?.driver?.capabilities().drafts;
    } catch {
      draftsCapable = false;
    }
    if (!draftsCapable || !entry) {
      new Notice("New sessions need an OpenCode v2 connector — set one as the default connector in settings.");
      return;
    }
    const { directories } = this.resolveDirectories(options, entry.connector);
    if (!directories.length) {
      new Notice("No directories configured — add them in OpenCode Sessions settings.");
      return;
    }
    if (directories.length === 1) {
      await this.openSessionDraft(directories[0], entry.connector.id);
      return;
    }
    await this.activateNewSessionPicker(directories, entry.connector.id);
  }

  async openSessionDraft(directory, connectorId = null) {
    const resolvedConnectorId = connectorId || this.registry.defaultConnector()?.connector.id || null;
    this.pendingDraftDirectory = directory;
    this.pendingSessionRef = { connectorId: resolvedConnectorId, sessionId: null };
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_SESSION,
      active: true,
      state: { draftDirectory: directory, connectorId: resolvedConnectorId },
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async activateNewSessionPicker(directories, connectorId = null) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEW_SESSION)[0];
    if (leaf && leaf.view instanceof NewSessionView) {
      leaf.view.setDirectories(directories, connectorId);
    } else {
      this.pendingPickerDirectories = directories;
      this.pendingPickerConnectorId = connectorId;
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

  promptForSessionId() {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Open session");
    const input = modal.contentEl.createEl("input", {
      type: "text",
      cls: "oc-id-input",
      attr: {
        placeholder: "ses_… or connector:session-id (e.g. claude:<uuid>)",
        spellcheck: "false",
      },
    });
    const submit = async () => {
      const value = input.value.trim();
      modal.close();
      if (!value) return;
      const { sessionId, unknownConnector } = this.resolveSessionRef(value);
      if (unknownConnector) {
        new Notice(`Unknown connector: ${unknownConnector}`);
        return;
      }
      if (!sessionId) return;
      if (!value.includes(":") && !sessionId.startsWith("ses_")) {
        new Notice("OpenCode v2 session IDs start with ses_ — prefix other backends' ids with a connector name");
        return;
      }
      await this.openSession(value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    modal.contentEl.createEl("button", { cls: "mod-cta", text: "Open" }).addEventListener("click", submit);
    modal.onOpen = () => input.focus();
    modal.open();
  }

  // ----- Listing / routing ----------------------------------------------------

  // Driver for options that may carry a `connector` name; the default
  // connector otherwise. Throws a descriptive error when nothing resolves.
  async loadSessions(options = {}) {
    const driver = this.driverForOptions(options);
    if (!driver) {
      throw new Error(
        typeof options.connector === "string" && options.connector
          ? `Unknown connector: ${options.connector}`
          : "No connector configured",
      );
    }
    return driver.listSessions(options);
  }

  driverForOptions(options = {}) {
    const name = options.connector;
    if (typeof name === "string" && name.trim()) {
      return this.registry.byName(name.trim())?.driver || null;
    }
    return this.registry.defaultConnector()?.driver || null;
  }

  // Registry entry for an options.connector name (or the default) — callers
  // that need the connector's config/id resolve it once and reuse it.
  connectorForOptions(options = {}) {
    const name = options.connector;
    if (typeof name === "string" && name.trim()) {
      return this.registry.byName(name.trim()) || null;
    }
    return this.registry.defaultConnector() || null;
  }

  // Normalizes directory options shared by listing and new-session picking.
  // Directory defaults come from the target connector's config.
  resolveDirectories(options = {}, connector = null) {
    const config = connector?.config || this.defaultConnectorConfig() || {};
    const requestedDirectories = options.dirs !== undefined
      ? options.dirs
      : options.directories !== undefined
        ? options.directories
        : config.directories;
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

  // Rows are decorated once here so every consumer (plugin view, Datacore JSX)
  // gets ready-to-render fields instead of re-implementing formatting.
  // With basedir set, directory labels are shown relative to it.
  // Drivers that compute their own state can preset `row.state`.
  decorateRow(row, basedir = "") {
    const state = row.state || this.sessionState(row);
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

  // Placeholder row for a pinned id that is not in the connector's data
  // (deleted or wrong id) — rendered as a dashed, muted card so typos show.
  missingSessionRow(id, entry = null) {
    const connector = entry?.connector || this.registry.defaultConnector()?.connector;
    return {
      id,
      title: null,
      titleLabel: id,
      state: "none",
      stateLabel: "",
      modelLabel: "",
      updatedLabel: "",
      directoryLabel: "",
      tokensLabel: "",
      agent: "",
      connectorId: connector?.id || null,
      connectorName: connector?.name || "",
      source: connector?.kind || "opencode2",
      missing: true,
    };
  }

  sessionState(row) {
    // Live first: the connector's own event stream knows the truth
    // (running, idle, interrupted, error, waiting for permission).
    const driver = this.registry.get(row.connectorId)?.driver;
    if (driver?.streamConnected()) {
      const live = driver.getLiveState(row.id);
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
  "permission.v2.asked",
  "permission.v2.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "session.step.started",
  "session.step.ended",
  "session.deleted",
  "session.removed",
]);
