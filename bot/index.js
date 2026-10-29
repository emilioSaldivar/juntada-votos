'use strict';
// Bot mínimo de WhatsApp para la juntada: SOLO envía mensajes.
// No lee chats, no sincroniza historial, no responde. Escucha únicamente en la
// red interna de Docker; la app de votación le pega con BOT_WEBHOOK_TOKEN.

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestWaWebVersion,
} = require('baileys');

const CFG = {
  port: Number(process.env.BOT_PORT || 3100),
  token: process.env.BOT_WEBHOOK_TOKEN || '',
  authDir: process.env.AUTH_DIR || './auth',
  maxPerHour: Number(process.env.BOT_MAX_PER_HOUR || 60),
  minGapMs: 1200,
  maxReconnectAttempts: 8,
  // Opcional: vincular con código de 8 caracteres en vez de QR (número del chip, ej. 595981123456)
  pairPhone: (process.env.BOT_PAIR_PHONE || '').replace(/\D/g, ''),
};

if (CFG.token.length < 16) {
  console.error('ERROR: definí BOT_WEBHOOK_TOKEN (mínimo 16 caracteres) en .env');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
let sock = null;
let status = 'CONNECTING'; // CONNECTING | QR | CONNECTED | LOGGED_OUT | ERROR
let attempts = 0;
let waVersion = null;
let generation = 0; // invalida los eventos de un socket que ya se reemplazó
let currentQr = null;
let pairingCode = null;
let registered = false;

// La versión de WhatsApp Web que trae Baileys queda vieja y WhatsApp rechaza la
// vinculación de clientes desactualizados: se usa la actual, con la interna de respaldo.
async function resolveVersion() {
  if (waVersion) return waVersion;
  try {
    const { version } = await fetchLatestWaWebVersion({});
    waVersion = version;
    console.log(`Usando WhatsApp Web ${version.join('.')}`);
  } catch (e) {
    console.warn('No se pudo obtener la versión actual de WhatsApp Web, uso la interna:', e.message);
  }
  return waVersion;
}

// ---------- conexión ----------

async function connect() {
  const gen = ++generation;
  fs.mkdirSync(CFG.authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(CFG.authDir);
  const version = await resolveVersion();
  registered = !!state.creds.registered;
  currentQr = pairingCode = null;
  status = 'CONNECTING';

  const s = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // no guardar chats en el servidor
    generateHighQualityLinkPreview: false,
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', (u) => {
    if (gen !== generation) return;
    if (u.qr) {
      status = 'QR';
      currentQr = u.qr;
      if (CFG.pairPhone && !pairingCode) {
        requestPairing(CFG.pairPhone).catch((e) => console.error('No se pudo pedir el código de vinculación:', e.message));
      } else if (!CFG.pairPhone) {
        console.log('\n📱 QR nuevo (también visible en /admin). WhatsApp → Dispositivos vinculados → Vincular un dispositivo:\n');
        qrcode.generate(u.qr, { small: true });
      }
    }
    if (u.connection === 'open') {
      status = 'CONNECTED';
      attempts = 0;
      currentQr = pairingCode = null;
      registered = true;
      console.log(`✅ WhatsApp conectado como +${phoneOf(s)}`);
      return;
    }
    if (u.connection !== 'close') return;

    const code = u.lastDisconnect?.error?.output?.statusCode;
    currentQr = pairingCode = null;
    // Reintentar con credenciales inválidas es la forma más rápida de que bloqueen
    // el número: ante loggedOut se borran y se arranca de cero, pidiendo un QR nuevo.
    if (code === DisconnectReason.loggedOut) {
      status = 'LOGGED_OUT';
      clearAuth();
      console.error('⛔ Sesión cerrada desde el teléfono. Se generará un QR nuevo para volver a vincular.');
      attempts = 0;
      setTimeout(() => connect().catch((e) => console.error('connect:', e.message)), 2000);
      return;
    }
    if (++attempts > CFG.maxReconnectAttempts) {
      status = 'ERROR';
      console.error(`⛔ Sin reconectar tras ${attempts - 1} intentos. Usá "Generar QR nuevo" en /admin o reiniciá el contenedor.`);
      return;
    }
    status = 'CONNECTING';
    // backoff exponencial con jitter y techo de 60s
    const base = Math.min(2 ** attempts * 1000, 60000);
    const delay = base / 2 + Math.random() * (base / 2);
    console.warn(`Conexión cerrada (código ${code}). Reintento ${attempts} en ${Math.round(delay / 1000)}s`);
    setTimeout(() => gen === generation && connect().catch((e) => console.error('connect:', e.message)), delay);
  });
}

function phoneOf(s) {
  return s?.user?.id?.split(':')[0]?.split('@')[0] || null;
}

function clearAuth() {
  // se vacía el contenido y no la carpeta: es un volumen montado
  for (const f of fs.existsSync(CFG.authDir) ? fs.readdirSync(CFG.authDir) : []) {
    fs.rmSync(`${CFG.authDir}/${f}`, { recursive: true, force: true });
  }
  registered = false;
}

async function restart({ wipe = false } = {}) {
  generation++; // el socket viejo deja de disparar reconexiones
  try { sock?.end(undefined); } catch {}
  if (wipe) clearAuth();
  attempts = 0;
  await connect();
}

async function requestPairing(phone) {
  if (registered) throw Object.assign(new Error('El bot ya está vinculado'), { status: 409 });
  if (status !== 'QR') throw Object.assign(new Error('Esperá a que el bot muestre el QR y probá de nuevo'), { status: 409 });
  const code = await sock.requestPairingCode(phone);
  pairingCode = code.match(/.{1,4}/g).join('-');
  console.log(`\n🔑 Código de vinculación: ${pairingCode}`);
  console.log('   WhatsApp → Dispositivos vinculados → Vincular un dispositivo → "Vincular con número de teléfono"\n');
  return pairingCode;
}

function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // margen en módulos
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + m},${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// ---------- envío con cola, pausa mínima y tope por hora ----------

let queue = Promise.resolve();
let lastSend = 0;
const sentAt = [];

function enqueueSend(phone, text) {
  const job = queue.then(async () => {
    const wait = lastSend + CFG.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const [info] = await sock.onWhatsApp(phone);
    if (!info?.exists) throw Object.assign(new Error('Ese número no tiene WhatsApp'), { status: 422 });
    await sock.sendMessage(info.jid, { text });
    lastSend = Date.now();
  });
  queue = job.catch(() => {});
  return job;
}

function overHourlyCap() {
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] > 3600e3) sentAt.shift();
  return sentAt.length >= CFG.maxPerHour;
}

// ---------- http interno ----------

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(CFG.token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
  });
}

const routes = {
  // Estado completo para el panel admin (incluye el QR, por eso pide token)
  'GET /status': async () => ({
    status,
    phone: status === 'CONNECTED' ? phoneOf(sock) : null,
    qrSvg: status === 'QR' && currentQr && !pairingCode ? qrSvg(currentQr) : null,
    pairingCode: status === 'QR' ? pairingCode : null,
    sentLastHour: (overHourlyCap(), sentAt.length),
    maxPerHour: CFG.maxPerHour,
  }),

  'POST /pair': async (req) => {
    const phone = String((await readJson(req)).phone || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) throw Object.assign(new Error('Número inválido'), { status: 400 });
    return { pairingCode: await requestPairing(phone) };
  },

  'POST /restart': async () => {
    await restart();
    return { ok: true };
  },

  'POST /logout': async () => {
    if (status === 'CONNECTED') {
      try { await sock.logout(); } catch {}
    }
    await restart({ wipe: true });
    console.log('🔌 Bot desvinculado desde el panel.');
    return { ok: true };
  },

  'POST /send': async (req) => {
    const { phone, message } = await readJson(req);
    if (!/^\d{8,15}$/.test(String(phone)) || typeof message !== 'string' || !message || message.length > 2000) {
      throw Object.assign(new Error('phone o message inválido'), { status: 400 });
    }
    if (status !== 'CONNECTED') throw Object.assign(new Error(`bot no conectado (${status})`), { status: 503 });
    if (overHourlyCap()) throw Object.assign(new Error('tope de mensajes por hora alcanzado'), { status: 429 });
    sentAt.push(Date.now());
    try {
      await enqueueSend(String(phone), message);
      // no se loguea el texto: puede contener códigos o links personales
      console.log(`→ enviado a …${String(phone).slice(-3)}`);
      return { ok: true };
    } catch (e) {
      console.error(`✗ envío a …${String(phone).slice(-3)}: ${e.message}`);
      throw e;
    }
  },
};

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status });
  const handler = routes[`${req.method} ${req.url}`];
  if (!handler) return reply(res, 404, { error: 'not found' });
  if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
  try {
    reply(res, 200, await handler(req));
  } catch (e) {
    reply(res, e.status || 502, { error: e.message });
  }
}).listen(CFG.port, () => console.log(`Bot escuchando en :${CFG.port} (solo red interna)`));

connect().catch((e) => {
  console.error('No se pudo iniciar:', e);
  process.exit(1);
});
