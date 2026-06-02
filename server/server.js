#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const PORT = Number(process.env.PORT || 3100);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const APPS_FILE = path.join(__dirname, 'apps.json');

const browsers = new Map();
const browserMeta = new WeakMap();
const plugins = new Map();
const pluginMeta = new WeakMap();
const appRegistry = new Map();
const messageHistory = new Map();
const heartbeatMeta = new WeakMap();
const HISTORY_LIMIT = 100;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Admin API routes
  if (url.pathname.startsWith('/api/admin/')) {
    handleAdminRoute(url, req, res);
    return;
  }

  if (req.method !== 'GET') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Redirect /admin to /admin/index.html
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    serveStatic('/admin/index.html', res);
    return;
  }

  serveStatic(url.pathname, res);
});

const browserWss = new WebSocketServer({ noServer: true });
const pluginWss = new WebSocketServer({ noServer: true });

initAppsFile();
loadAppRegistry();

function initAppsFile() {
  if (!fs.existsSync(APPS_FILE)) {
    const hash = bcrypt.hashSync('admin', 10);
    fs.writeFileSync(APPS_FILE, JSON.stringify({ adminPassword: hash, apps: {} }, null, 2) + '\n');
    console.log('[admin] created apps.json with default password');
    return;
  }

  const data = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  if (!data.adminPassword) {
    data.adminPassword = bcrypt.hashSync('admin', 10);
    fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log('[admin] reset admin password to default');
  }
}

function readAppsFile() {
  return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
}

function writeAppsFile(data) {
  fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2) + '\n');
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/ws') {
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit('connection', ws, req);
    });
    return;
  }

  if (url.pathname === '/plugin') {
    pluginWss.handleUpgrade(req, socket, head, (ws) => {
      pluginWss.emit('connection', ws, req);
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

browserWss.on("connection", (ws) => {
  console.log("browser connected");
  initHeartbeat(ws);

  ws.on('pong', () => markPong(ws));
  ws.on('message', (raw) => {
    const message = parseJson(raw);
    if (!message) return;

    if (message.type === 'register') {
      registerBrowser(ws, message);
      return;
    }

    if (message.type === 'message') {
      handleBrowserMessage(ws, message);
    }
  });

  ws.on('close', () => removeBrowser(ws));
});

pluginWss.on("connection", (ws) => {
  console.log("plugin connected");
  initHeartbeat(ws);

  ws.on('pong', () => markPong(ws));
  ws.on('message', (raw) => {
    const message = parseJson(raw);
    if (!message) return;

    if (message.type === 'register') {
      registerPlugin(ws, message);
      return;
    }

    if (message.type === 'outgoing') {
      handlePluginOutgoing(ws, message);
    }
  });

  ws.on('close', () => removePlugin(ws));
});

const heartbeatTimer = setInterval(() => {
  pingConnections(browserWss);
  pingConnections(pluginWss);
}, 30_000);

heartbeatTimer.unref();

server.listen(PORT, () => {
  console.log(`webchat server listening on http://localhost:${PORT}`);
});

function serveStatic(pathname, res) {
  const decodedPath = safeDecode(pathname);
  if (!decodedPath) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const relativePath = decodedPath === '/' || decodedPath === '/index.html'
    ? 'index.html'
    : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relativePath);

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const body = fs.readFileSync(filePath);
    const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(body);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, 'Not Found');
      return;
    }

    console.error('static file error:', error);
    sendText(res, 500, 'Internal Server Error');
  }
}

function registerBrowser(ws, message) {
  console.log("registering browser:", message.userId);
  const userId = typeof message.userId === 'string' && message.userId.trim() ? message.userId : null;
  const userName = typeof message.userName === 'string' && message.userName.trim() ? message.userName : userId;

  if (!userId) {
    send(ws, { type: 'error', error: 'userId is required' });
    return;
  }

  removeBrowser(ws);

  let sockets = browsers.get(userId);
  if (!sockets) {
    sockets = new Set();
    browsers.set(userId, sockets);
  }

  sockets.add(ws);
  browserMeta.set(ws, { userId, userName, lastSeen: Date.now() });

  send(ws, { type: 'registered', userId });
  send(ws, { type: 'app_list', apps: listApps() });
  send(ws, { type: 'history', messages: getHistoryForUser(userId) });
}

function registerPlugin(ws, message) {
  const appId = typeof message.appId === 'string' && message.appId.trim() ? message.appId : null;
  const secret = typeof message.secret === 'string' ? message.secret : '';
  console.log("registering plugin app:", appId);

  if (!appId) {
    send(ws, { type: 'register_error', ok: false, error: 'appId is required' });
    ws.close();
    return;
  }

  const appEntry = appRegistry.get(appId);
  if (!appEntry) {
    send(ws, { type: 'register_error', ok: false, error: 'invalid_app' });
    ws.close();
    return;
  }

  if (!appEntry.enabled) {
    send(ws, { type: 'register_error', ok: false, error: 'app_disabled' });
    ws.close();
    return;
  }

  if (!appEntry.secretHash || !bcrypt.compareSync(secret, appEntry.secretHash)) {
    send(ws, { type: 'register_error', ok: false, error: 'invalid_secret' });
    ws.close();
    return;
  }

  registerApp(ws, appId, appEntry.name);

  send(ws, { type: 'registered', ok: true, appId });
  send(ws, { type: 'app_list', apps: listApps() });
  broadcastAppList();
}

function registerApp(ws, appId, name) {
  const existing = plugins.get(appId);
  if (existing && existing.ws !== ws) {
    existing.ws.close();
  }

  const now = Date.now();
  plugins.set(appId, {
    ws,
    appId,
    name: name || appId,
    connectedAt: now,
    lastSeen: now,
  });
  pluginMeta.set(ws, { appId, lastSeen: now });
}

function handleBrowserMessage(ws, message) {
  const meta = browserMeta.get(ws);
  if (!meta) {
    send(ws, { type: 'error', error: 'browser must register first' });
    return;
  }

  routeBrowserMessage(ws, message, meta);
}

function routeBrowserMessage(ws, message, meta = browserMeta.get(ws)) {
  if (!meta) {
    send(ws, { type: 'error', error: 'browser must register first' });
    return;
  }

  const appId = typeof message.appId === 'string' && message.appId.trim() ? message.appId : null;
  const content = typeof message.content === 'string' ? message.content : null;

  if (!appId || content === null) {
    send(ws, { type: 'error', error: 'appId and content are required' });
    return;
  }

  const plugin = plugins.get(appId);

  if (!plugin || plugin.ws.readyState !== WebSocket.OPEN) {
    send(ws, { type: 'error', error: `app is unavailable: ${appId}`, appId });
    return;
  }

  const messageId = typeof message.messageId === 'string' && message.messageId.trim()
    ? message.messageId
    : createMessageId('user');

  appendHistory({
    userId: meta.userId,
    appId,
    from: 'user',
    content,
    messageId,
  });

  send(plugin.ws, {
    type: 'incoming',
    appId,
    userId: meta.userId,
    userName: meta.userName,
    conversationId: meta.userId,
    content,
    messageId,
  });
}

function handlePluginOutgoing(ws, message) {
  routePluginOutgoing(ws, message);
}

function routePluginOutgoing(ws, message) {
  const meta = pluginMeta.get(ws);
  if (!meta) {
    send(ws, { type: 'error', error: 'plugin must register first' });
    return;
  }

  const appId = typeof message.appId === 'string' && message.appId.trim() ? message.appId : null;
  const userId = typeof message.userId === 'string' && message.userId.trim() ? message.userId : null;
  const content = typeof message.content === 'string' ? message.content : null;

  if (appId !== meta.appId) {
    send(ws, { type: 'error', error: 'appId does not match registered app', expectedAppId: meta.appId });
    return;
  }

  if (!userId || content === null) {
    send(ws, { type: 'error', error: 'appId, userId, and content are required' });
    return;
  }

  const messageId = typeof message.messageId === 'string' && message.messageId.trim()
    ? message.messageId
    : createMessageId('agent');
  const outbound = {
    type: 'message',
    from: 'agent',
    appId: meta.appId,
    content,
    messageId,
  };

  appendHistory({
    userId,
    appId: meta.appId,
    from: 'agent',
    content,
    messageId,
  });

  const sockets = browsers.get(userId);
  if (!sockets) return;

  for (const browser of sockets) {
    send(browser, outbound);
  }

  send(ws, { type: 'delivery_ack', ok: true, userId, messageId });
}

function removeBrowser(ws) {
  const meta = browserMeta.get(ws);
  if (!meta) return;

  const sockets = browsers.get(meta.userId);
  if (sockets) {
    sockets.delete(ws);
    if (sockets.size === 0) {
      browsers.delete(meta.userId);
    }
  }
}

function removePlugin(ws) {
  const meta = pluginMeta.get(ws);
  if (!meta) return;

  const plugin = plugins.get(meta.appId);
  if (!plugin || plugin.ws !== ws) return;

  plugins.delete(meta.appId);
  broadcastAppList();
}

function historyKey(userId, appId) {
  return JSON.stringify([userId, appId]);
}

function appendHistory({ userId, appId, from, content, messageId }) {
  const key = historyKey(userId, appId);
  const messages = messageHistory.get(key) || [];
  messages.push({
    from,
    appId,
    content,
    timestamp: Date.now(),
    messageId,
  });

  if (messages.length > HISTORY_LIMIT) {
    messages.splice(0, messages.length - HISTORY_LIMIT);
  }

  messageHistory.set(key, messages);
}

function getHistoryForUser(userId) {
  const messagesByApp = {};

  for (const [key, messages] of messageHistory.entries()) {
    const [historyUserId, appId] = JSON.parse(key);
    if (historyUserId !== userId) continue;
    messagesByApp[appId] = messages;
  }

  return messagesByApp;
}

function listApps() {
  return Array.from(plugins.values()).map((plugin) => ({
    appId: plugin.appId,
    name: plugin.name || plugin.appId,
  }));
}

function broadcastAppList() {
  const apps = listApps();
  for (const sockets of browsers.values()) {
    for (const ws of sockets) {
      send(ws, { type: 'app_list', apps });
    }
  }

  for (const plugin of plugins.values()) {
    send(plugin.ws, { type: 'app_list', apps });
  }
}

function pingConnections(wss) {
  for (const ws of wss.clients) {
    const meta = heartbeatMeta.get(ws) || { missedPongs: 0 };

    if (meta.missedPongs >= 3) {
      ws.close();
      continue;
    }

    meta.missedPongs += 1;
    heartbeatMeta.set(ws, meta);
    ws.ping();
  }
}

function initHeartbeat(ws) {
  heartbeatMeta.set(ws, { missedPongs: 0 });
}

function markPong(ws) {
  heartbeatMeta.set(ws, { missedPongs: 0 });

  const now = Date.now();
  const browser = browserMeta.get(ws);
  if (browser) {
    browser.lastSeen = now;
  }

  const plugin = pluginMeta.get(ws);
  if (plugin) {
    plugin.lastSeen = now;
    const registeredPlugin = plugins.get(plugin.appId);
    if (registeredPlugin && registeredPlugin.ws === ws) {
      registeredPlugin.lastSeen = now;
    }
  }
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function createMessageId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadAppRegistry() {
  const filePath = path.join(__dirname, 'apps.json');
  if (!fs.existsSync(filePath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    appRegistry.clear();

    for (const [appId, app] of Object.entries(data.apps || {})) {
      appRegistry.set(appId, {
        appId,
        name: app.name || appId,
        secretHash: app.secretHash,
        enabled: app.enabled !== false,
      });
    }
  } catch (error) {
    console.error('failed to load apps registry:', error);
  }
}

function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

// ── Admin helpers ──────────────────────────────────────────────────────────────

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new Error('body_too_large');
  }
  const raw = Buffer.concat(chunks).toString();
  return raw.trim() ? JSON.parse(raw) : {};
}

function requireAdmin(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token) {
    sendJson(res, 401, { ok: false, error: 'missing_token' });
    return false;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      sendJson(res, 403, { ok: false, error: 'invalid_role' });
      return false;
    }
    return true;
  } catch {
    sendJson(res, 401, { ok: false, error: 'invalid_or_expired_token' });
    return false;
  }
}

// ── Admin route dispatcher ─────────────────────────────────────────────────────

async function handleAdminRoute(url, req, res) {
  const pathname = url.pathname;

  try {
    // POST /api/admin/login
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return handleAdminLogin(body, res);
    }

    // PUT /api/admin/password
    if (pathname === '/api/admin/password') {
      if (req.method !== 'PUT') {
        return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      }
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      return handleAdminPassword(body, res);
    }

    // GET/POST /api/admin/apps
    if (pathname === '/api/admin/apps') {
      if (req.method === 'GET') {
        if (!requireAdmin(req, res)) return;
        return handleAdminListApps(res);
      }
      if (req.method === 'POST') {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        return handleAdminCreateApp(body, res);
      }
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    // /api/admin/apps/:appId
    const appMatch = pathname.match(/^\/api\/admin\/apps\/(wch_[0-9a-f]{16})$/);
    if (appMatch) {
      const appId = appMatch[1];

      if (req.method === 'GET') {
        if (!requireAdmin(req, res)) return;
        return handleAdminGetApp(appId, res);
      }
      if (req.method === 'DELETE') {
        if (!requireAdmin(req, res)) return;
        return handleAdminDeleteApp(appId, res);
      }
      if (req.method === 'PATCH') {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        return handleAdminPatchApp(appId, body, res);
      }
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    if (err.message === 'body_too_large') {
      return sendJson(res, 400, { ok: false, error: 'body_too_large' });
    }
    return sendJson(res, 400, { ok: false, error: 'invalid_body' });
  }
}

// ── Admin route handlers ───────────────────────────────────────────────────────

function handleAdminLogin(body, res) {
  const { password } = body || {};

  if (typeof password !== 'string' || !password.trim()) {
    return sendJson(res, 400, { ok: false, error: 'password_required' });
  }

  const store = readAppsFile();
  if (!store.adminPassword) {
    return sendJson(res, 500, { ok: false, error: 'admin_password_not_initialized' });
  }

  if (!bcrypt.compareSync(password, store.adminPassword)) {
    return sendJson(res, 401, { ok: false, error: 'invalid_password' });
  }

  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  return sendJson(res, 200, { ok: true, token, expiresIn: 86400 });
}

function handleAdminListApps(res) {
  const store = readAppsFile();
  const apps = Object.values(store.apps || {})
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((app) => ({
      appId: app.appId,
      name: app.name,
      enabled: app.enabled !== false,
      connected: plugins.has(app.appId),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt || app.createdAt,
    }));

  return sendJson(res, 200, { ok: true, apps });
}

function handleAdminCreateApp(body, res) {
  const { name } = body || {};

  if (typeof name !== 'string' || !name.trim()) {
    return sendJson(res, 400, { ok: false, error: 'name_required' });
  }

  const trimmedName = name.trim();
  if (trimmedName.length > 64) {
    return sendJson(res, 400, { ok: false, error: 'name_too_long' });
  }

  const store = readAppsFile();

  // Generate unique appId
  let appId;
  for (let i = 0; i < 10; i++) {
    appId = 'wch_' + crypto.randomBytes(8).toString('hex');
    if (!store.apps[appId]) break;
    appId = null;
  }
  if (!appId) {
    return sendJson(res, 500, { ok: false, error: 'app_id_generation_failed' });
  }

  const secret = 'sk-wch-' + crypto.randomBytes(16).toString('hex');
  const secretHash = bcrypt.hashSync(secret, 10);
  const now = new Date().toISOString();

  store.apps[appId] = {
    appId,
    secretHash,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
    enabled: true,
  };

  try {
    writeAppsFile(store);
    loadAppRegistry();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'save_failed' });
  }

  return sendJson(res, 200, {
    ok: true,
    app: {
      appId,
      name: trimmedName,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    secret,
  });
}

function handleAdminGetApp(appId, res) {
  const store = readAppsFile();
  const app = store.apps[appId];
  if (!app) {
    return sendJson(res, 404, { ok: false, error: 'app_not_found' });
  }

  return sendJson(res, 200, {
    ok: true,
    app: {
      appId: app.appId,
      name: app.name,
      enabled: app.enabled !== false,
      connected: plugins.has(app.appId),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt || app.createdAt,
    },
  });
}

function handleAdminDeleteApp(appId, res) {
  const store = readAppsFile();
  if (!store.apps[appId]) {
    return sendJson(res, 404, { ok: false, error: 'app_not_found' });
  }

  delete store.apps[appId];

  try {
    writeAppsFile(store);
    loadAppRegistry();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'save_failed' });
  }

  return sendJson(res, 200, { ok: true, appId });
}

function handleAdminPatchApp(appId, body, res) {
  const store = readAppsFile();
  const app = store.apps[appId];
  if (!app) {
    return sendJson(res, 404, { ok: false, error: 'app_not_found' });
  }

  if (typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: 'enabled_required' });
  }

  app.enabled = body.enabled;
  app.updatedAt = new Date().toISOString();

  try {
    writeAppsFile(store);
    loadAppRegistry();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'save_failed' });
  }

  return sendJson(res, 200, {
    ok: true,
    app: {
      appId: app.appId,
      name: app.name,
      enabled: app.enabled,
      connected: plugins.has(app.appId),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    },
  });
}

function handleAdminPassword(body, res) {
  const { oldPassword, newPassword } = body || {};

  if (typeof oldPassword !== 'string' || !oldPassword.trim()) {
    return sendJson(res, 400, { ok: false, error: 'old_password_required' });
  }

  if (typeof newPassword !== 'string' || !newPassword.trim()) {
    return sendJson(res, 400, { ok: false, error: 'new_password_required' });
  }

  const trimmedNew = newPassword.trim();
  if (trimmedNew.length < 6) {
    return sendJson(res, 400, { ok: false, error: 'new_password_too_short' });
  }

  if (trimmedNew === oldPassword.trim()) {
    return sendJson(res, 400, { ok: false, error: 'password_unchanged' });
  }

  const store = readAppsFile();
  if (!bcrypt.compareSync(oldPassword, store.adminPassword)) {
    return sendJson(res, 401, { ok: false, error: 'invalid_old_password' });
  }

  store.adminPassword = bcrypt.hashSync(trimmedNew, 10);

  try {
    writeAppsFile(store);
  } catch {
    return sendJson(res, 500, { ok: false, error: 'save_failed' });
  }

  return sendJson(res, 200, { ok: true });
}
