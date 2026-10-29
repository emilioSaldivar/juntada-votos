'use strict';
// Juntada · votación de fecha para el grupo de amigos.
// Node >= 20, sin dependencias externas. Datos en DATA_DIR/db.json.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '.env'));

const CFG = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  title: process.env.EVENT_TITLE || '¿Cuándo nos juntamos?',
  start: process.env.START_DATE || '2026-11-02',
  end: process.env.END_DATE || '2026-12-20',
  countryCode: process.env.DEFAULT_COUNTRY_CODE || '595',
  botUrl: process.env.BOT_WEBHOOK_URL || '',
  botToken: process.env.BOT_WEBHOOK_TOKEN || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  cookieSecure: process.env.COOKIE_SECURE, // 'true' | 'false' | undefined (auto)
};

if (CFG.adminToken.length < 12) {
  console.error('ERROR: definí ADMIN_TOKEN (mínimo 12 caracteres) en .env');
  process.exit(1);
}

const DAYS = buildDays(CFG.start, CFG.end);
const DAY_SET = new Set(DAYS);
const SESSION_DAYS = 60;
const OTP_TTL_MS = 10 * 60 * 1000;

// ---------- persistencia ----------

const DB_FILE = path.join(CFG.dataDir, 'db.json');
fs.mkdirSync(CFG.dataDir, { recursive: true });
const db = loadDb();
let saveTimer = null;

function loadDb() {
  const empty = { members: [], votes: {}, sessions: {}, settings: { closed: false, finalDate: null } };
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return empty;
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}

// ---------- helpers ----------

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function buildDays(start, end) {
  const out = [];
  const d = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = CFG.countryCode + p.slice(1);
  else if (!p.startsWith(CFG.countryCode) && p.length <= 9) p = CFG.countryCode + p;
  return p.length >= 8 && p.length <= 15 ? p : null;
}

const rnd = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function memberLink(m) {
  return `${CFG.baseUrl}/v/${m.token}`;
}

function linkMessage(m) {
  return [
    `Haupei primo ${m.name}, como andamos ?`,
    'Vota pues el dia que mejor te quede a vos podes elegir mas de un dia kp',
    'Y asi nos juntamos con los rompediscotek antes de que termine el año viejo, ijapio ?',
    'Este es el link para votar kp:',
    memberLink(m),
  ].join('\n');
}

function reminderMessage(m) {
  return `${m.name}, ¡faltás vos! 👀 Votá qué día nos juntamos, es un toque:\n${memberLink(m)}`;
}

// Llamada al bot por la red interna. `path` es relativo a la base de BOT_WEBHOOK_URL (…/send).
async function botCall(path, { method = 'GET', body, timeout = 20000 } = {}) {
  if (!CFG.botUrl) throw Object.assign(new Error('Bot no configurado'), { status: 503 });
  const res = await fetch(CFG.botUrl.replace(/\/send$/, path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(CFG.botToken ? { Authorization: `Bearer ${CFG.botToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `bot respondió ${res.status}`), { status: res.status });
  return data;
}

async function botStatus() {
  if (!CFG.botUrl) return 'OFF';
  try {
    return (await botCall('/health', { timeout: 3000 })).status || 'ERROR';
  } catch {
    return 'UNREACHABLE';
  }
}

function sendWhatsApp(phone, message) {
  return botCall('/send', { method: 'POST', body: { phone, message } });
}

// Rate limit simple en memoria: key -> [timestamps]
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
  for (const [sid, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[sid];
  for (const [p, o] of otps) if (o.exp < now) otps.delete(p);
}, 10 * 60 * 1000).unref();

const otps = new Map(); // phone -> { hash, exp, tries }

// ---------- http ----------

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function isSecure(req) {
  if (CFG.cookieSecure) return CFG.cookieSecure === 'true';
  return req.headers['x-forwarded-proto'] === 'https' || CFG.baseUrl.startsWith('https');
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(req, res, memberId) {
  const sid = rnd(32);
  db.sessions[sha(sid)] = { memberId, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `sid=${sid}; ${flags}`);
}

function currentMember(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = db.sessions[sha(sid)];
  if (!s || s.exp < Date.now()) return null;
  return db.members.find((m) => m.id === s.memberId) || null;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new HttpError(413, 'Demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'No encontrado');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado');
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
  });
}

// ---------- estado público para votantes ----------

function results() {
  const byDay = Object.fromEntries(DAYS.map((d) => [d, []]));
  for (const m of db.members) {
    for (const d of db.votes[m.id]?.dates || []) if (byDay[d]) byDay[d].push(m.id);
  }
  return byDay;
}

function stateFor(member) {
  return {
    me: { id: member.id, name: member.name, dates: db.votes[member.id]?.dates || [] },
    config: { title: CFG.title, days: DAYS, closed: db.settings.closed, finalDate: db.settings.finalDate },
    members: db.members.map((m) => ({ id: m.id, name: m.name, voted: !!db.votes[m.id]?.dates?.length })),
    byDay: results(),
  };
}

// ---------- rutas ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);

  // Link mágico personal
  const magic = p.match(/^\/v\/([A-Za-z0-9_-]{10,})$/);
  if (magic && req.method === 'GET') {
    const m = db.members.find((x) => safeEqual(x.token, magic[1]));
    if (!m) return send(res, 302, '', { Location: '/?e=link' });
    setSession(req, res, m.id);
    return send(res, 302, '', { Location: '/' });
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p === '/admin') return serveStatic(res, 'admin.html');
  if (!p.startsWith('/api/')) return serveStatic(res, p.slice(1));

  // ---- auth por código ----
  if (p === '/api/auth/request' && req.method === 'POST') {
    const { phone: raw } = await readBody(req);
    const phone = normalizePhone(raw);
    if (!phone) throw new HttpError(400, 'Ese número no parece válido');
    if (limited('ip:' + ip, 20, 15 * 60e3) || limited('ph:' + phone, 4, 15 * 60e3)) {
      throw new HttpError(429, 'Muchos intentos, esperá unos minutos ⏳');
    }
    const m = db.members.find((x) => x.phone === phone);
    if (!m) throw new HttpError(404, 'Ese número no está en la lista del grupo 🤔 Hablá con el admin.');
    if (!CFG.botUrl) throw new HttpError(503, 'El envío por WhatsApp no está activo. Pedile tu link personal al admin.');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    otps.set(phone, { hash: sha(code), exp: Date.now() + OTP_TTL_MS, tries: 0 });
    await sendWhatsApp(phone, `Tu código para votar la juntada es: *${code}* 🔐\nVence en 10 minutos.`).catch((e) => {
      console.error('Bot error:', e.message);
      otps.delete(phone);
      if (e.status === 422) throw new HttpError(422, 'Ese número no tiene WhatsApp 🤔');
      throw new HttpError(502, 'No pudimos mandar el WhatsApp, probá de nuevo en un rato.');
    });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const o = phone && otps.get(phone);
    if (!o || o.exp < Date.now()) throw new HttpError(400, 'El código venció, pedí otro');
    if (++o.tries > 5) {
      otps.delete(phone);
      throw new HttpError(429, 'Demasiados intentos, pedí otro código');
    }
    if (!safeEqual(o.hash, sha(String(body.code || '').trim()))) throw new HttpError(400, 'Código incorrecto');
    otps.delete(phone);
    const m = db.members.find((x) => x.phone === phone);
    if (!m) throw new HttpError(404, 'Usuario no encontrado');
    setSession(req, res, m.id);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const sid = cookies(req).sid;
    if (sid) delete db.sessions[sha(sid)], save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }

  if (p === '/api/meta' && req.method === 'GET') {
    return send(res, 200, { title: CFG.title, botEnabled: !!CFG.botUrl, countryCode: CFG.countryCode });
  }

  // ---- votante autenticado ----
  if (p === '/api/state' && req.method === 'GET') {
    const m = currentMember(req);
    if (!m) throw new HttpError(401, 'No autenticado');
    return send(res, 200, stateFor(m));
  }

  if (p === '/api/votes' && req.method === 'PUT') {
    const m = currentMember(req);
    if (!m) throw new HttpError(401, 'No autenticado');
    if (db.settings.closed) throw new HttpError(409, 'La votación ya cerró 🔒');
    const { dates } = await readBody(req);
    if (!Array.isArray(dates)) throw new HttpError(400, 'Formato inválido');
    const clean = [...new Set(dates)].filter((d) => DAY_SET.has(d)).sort();
    db.votes[m.id] = { dates: clean, updatedAt: new Date().toISOString() };
    save();
    return send(res, 200, stateFor(m));
  }

  // ---- admin ----
  if (p.startsWith('/api/admin/')) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (limited('adm:' + ip, 120, 60e3) || !safeEqual(auth, CFG.adminToken)) {
      throw new HttpError(401, 'Token de admin inválido');
    }
    return handleAdmin(req, res, p);
  }

  throw new HttpError(404, 'No encontrado');
}

async function handleAdmin(req, res, p) {
  const adminView = () => ({
    botEnabled: !!CFG.botUrl,
    settings: db.settings,
    days: DAYS,
    byDay: results(),
    members: db.members.map((m) => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      link: memberLink(m),
      linkMessage: linkMessage(m),
      reminderMessage: reminderMessage(m),
      dates: db.votes[m.id]?.dates || [],
      updatedAt: db.votes[m.id]?.updatedAt || null,
    })),
  });

  if (p === '/api/admin/state' && req.method === 'GET') return send(res, 200, { ...adminView(), botStatus: await botStatus() });

  // Alta (una o varias líneas "Nombre, número")
  if (p === '/api/admin/members' && req.method === 'POST') {
    const { text } = await readBody(req);
    const added = [];
    const errors = [];
    for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(.+?)[,;\t]\s*([+\d][\d\s\-()]+)$/);
      const phone = m && normalizePhone(m[2]);
      if (!m || !phone) {
        errors.push(`"${line}": formato esperado "Nombre, 0981123456"`);
        continue;
      }
      if (db.members.some((x) => x.phone === phone)) {
        errors.push(`"${line}": ese número ya existe`);
        continue;
      }
      const member = { id: rnd(6), name: m[1].trim().slice(0, 40), phone, token: rnd(18), createdAt: new Date().toISOString() };
      db.members.push(member);
      added.push(member.name);
    }
    save();
    return send(res, 200, { added, errors, ...adminView() });
  }

  const mm = p.match(/^\/api\/admin\/members\/([\w-]+)(\/(\w+))?$/);
  if (mm) {
    const m = db.members.find((x) => x.id === mm[1]);
    if (!m) throw new HttpError(404, 'Miembro no encontrado');
    const action = mm[3];
    if (!action && req.method === 'DELETE') {
      db.members = db.members.filter((x) => x !== m);
      delete db.votes[m.id];
      for (const [sid, s] of Object.entries(db.sessions)) if (s.memberId === m.id) delete db.sessions[sid];
      save();
      return send(res, 200, adminView());
    }
    if (action === 'regenerate' && req.method === 'POST') {
      m.token = rnd(18);
      for (const [sid, s] of Object.entries(db.sessions)) if (s.memberId === m.id) delete db.sessions[sid];
      save();
      return send(res, 200, adminView());
    }
    if (action === 'send' && req.method === 'POST') {
      const { kind } = await readBody(req);
      await sendWhatsApp(m.phone, kind === 'reminder' ? reminderMessage(m) : linkMessage(m)).catch((e) => {
        throw new HttpError(502, 'Bot: ' + e.message);
      });
      return send(res, 200, { ok: true });
    }
  }

  // Envío masivo por bot: kind = 'link' (todos) | 'reminder' (solo los que no votaron)
  if (p === '/api/admin/broadcast' && req.method === 'POST') {
    const { kind } = await readBody(req);
    const targets = kind === 'reminder' ? db.members.filter((m) => !db.votes[m.id]?.dates?.length) : db.members;
    const report = [];
    for (const m of targets) {
      try {
        await sendWhatsApp(m.phone, kind === 'reminder' ? reminderMessage(m) : linkMessage(m));
        report.push({ name: m.name, ok: true });
      } catch (e) {
        report.push({ name: m.name, ok: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 1500)); // no saturar WhatsApp
    }
    return send(res, 200, { report });
  }

  // Vinculación del bot desde el panel: QR, código por número, QR nuevo, desvincular
  if (p === '/api/admin/bot' && req.method === 'GET') {
    if (!CFG.botUrl) return send(res, 200, { status: 'OFF' });
    try {
      return send(res, 200, await botCall('/status', { timeout: 5000 }));
    } catch {
      return send(res, 200, { status: 'UNREACHABLE' });
    }
  }
  const botAction = p.match(/^\/api\/admin\/bot\/(pair|restart|logout)$/);
  if (botAction && req.method === 'POST') {
    const body = botAction[1] === 'pair' ? { phone: normalizePhone((await readBody(req)).phone) } : {};
    try {
      return send(res, 200, await botCall('/' + botAction[1], { method: 'POST', body }));
    } catch (e) {
      throw new HttpError(e.status && e.status < 500 ? e.status : 502, e.message);
    }
  }

  if (p === '/api/admin/settings' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.closed === 'boolean') db.settings.closed = body.closed;
    if ('finalDate' in body) {
      if (body.finalDate !== null && !DAY_SET.has(body.finalDate)) throw new HttpError(400, 'Fecha fuera de rango');
      db.settings.finalDate = body.finalDate;
    }
    save();
    return send(res, 200, adminView());
  }

  throw new HttpError(404, 'No encontrado');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    await handle(req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Error interno' });
  }
});

server.listen(CFG.port, () => {
  console.log(`Juntada lista en ${CFG.baseUrl} (puerto ${CFG.port}) · ${DAYS.length} días · bot ${CFG.botUrl ? 'ON' : 'OFF'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearTimeout(saveTimer);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    process.exit(0);
  });
}
