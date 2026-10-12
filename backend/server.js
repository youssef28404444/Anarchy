'use strict';
require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const moment = require('moment-timezone');
moment.updateLocale('en', { week: { dow: 6 } });
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Partials, Events,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const PORT = Number(process.env.PORT || 5000);
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const BOOTSTRAP_ID = process.env.BOOTSTRAP_DISCORD_USER_ID || '';
const TIMEZONE = process.env.TIMEZONE || 'Africa/Cairo';
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || 'http://localhost').split(',').map(x => x.trim());
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost/ANARCHY/';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'anarchy.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discord_members (
  user_id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, avatar TEXT,
  role_ids TEXT NOT NULL DEFAULT '[]', in_guild INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_clock_totals (user_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL DEFAULT '', minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,kind,period));
CREATE TABLE IF NOT EXISTS clock_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL DEFAULT '', minutes INTEGER NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_seconds INTEGER,
  start_source TEXT NOT NULL DEFAULT 'discord', end_source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shifts_user_started ON shifts(user_id, started_at);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection, created_at);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_number TEXT UNIQUE,
  owner_id TEXT NOT NULL, subject TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
  author_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_name TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT,
  result TEXT NOT NULL DEFAULT 'success', ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`);

const nowIso = () => new Date().toISOString();
const readSetting = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
};
const writeSetting = (key, value) => db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, JSON.stringify(value), nowIso());
const DEFAULT_ROLES = { owner: '', boss: '', coboss: '', leader: '', gang: '', memberManager: '', taskManager: '', resourceManager: '', armoryManager: '', mediaManager: '', ticketManager: '', logsViewer: '', clockManager: '' };

function importLegacyClockData() {
  if (readSetting('legacyClockImported', false)) return;
  const legacyPath = path.join(DATA_DIR, 'clock-legacy.sqlite');
  if (!fs.existsSync(legacyPath)) { writeSetting('legacyClockImported', true); return; }
  let legacy;
  try {
    legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    if (tables.includes('kv')) {
      const rows = legacy.prepare('SELECT id,value FROM kv').all();
      if (!rows.length) return; // The supplied archive has an empty database; retry if a real legacy DB is placed here.
      const insert = db.prepare('INSERT OR IGNORE INTO legacy_clock_totals(user_id,kind,period,minutes) VALUES(?,?,?,?)');
      const tx = db.transaction(() => {
        for (const row of rows) {
          let value; try { value = JSON.parse(row.value); } catch { value = row.value; }
          const key = String(row.id);
          let match = key.match(/^alltime_(\d{17,20})$/);
          if (match && Number.isFinite(Number(value))) { insert.run(match[1], 'alltime', '', Math.max(0, Math.floor(Number(value)))); continue; }
          match = key.match(/^weekly_(.+)_(\d{17,20})$/);
          if (match && Number.isFinite(Number(value))) { insert.run(match[2], 'week', match[1], Math.max(0, Math.floor(Number(value)))); continue; }
          match = key.match(/^monthly_(.+)_(\d{17,20})$/);
          if (match && Number.isFinite(Number(value))) { insert.run(match[2], 'month', match[1], Math.max(0, Math.floor(Number(value)))); continue; }
          match = key.match(/^status_(\d{17,20})$/);
          if (match && value === 'working') {
            const startedRow = rows.find(x => x.id === `shiftStart_${match[1]}`);
            let started = 0; try { started = Number(JSON.parse(startedRow?.value || '0')); } catch {}
            if (started > 0 && !db.prepare('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL').get(match[1])) db.prepare('INSERT INTO shifts(user_id,started_at,start_source,created_at) VALUES(?,?,?,?)').run(match[1], Date.now(), 'legacy-import-resume', nowIso());
          }
        }
      });
      tx();
    }
    writeSetting('legacyClockImported', true);
    console.log('[Migration] Legacy clock data import completed.');
  } catch (error) {
    console.error('[Migration] Legacy clock import skipped:', error.message);
  } finally { if (legacy) legacy.close(); }
}

const roleMappings = () => ({ ...DEFAULT_ROLES, ...(readSetting('roleMappings', {}) || {}) });
const botSettings = () => ({
  activityName: 'Kayan CFW', clockChannelId: '', logChannelId: '', taskChannelId: '', leaderboardChannelId: '',
  supportCategoryId: '', ticketLogChannelId: '', announcementChannelId: '', clipRequestChannelId:'', galleryRequestChannelId:'',
  ...(readSetting('botSettings', {}) || {})
});
const insertLog = ({ actorId = null, actorName = null, action, targetType = null, targetId = null, details = {}, result = 'success', req = null }) => {
  db.prepare(`INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,details,result,ip,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(actorId, actorName, action, targetType, targetId, JSON.stringify(details), result, req?.ip || null, nowIso());
};
const readUser = id => db.prepare('SELECT * FROM discord_members WHERE user_id = ?').get(id);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Keep CSP disabled for the current static SPA (Google Fonts and inline legacy attributes).
// Add a strict nonce-based CSP before production deployment.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_ORIGIN.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(session({
  name: 'anarchy.sid',
  secret: process.env.SESSION_SECRET || 'LOCAL_ONLY_CHANGE_THIS_SESSION_SECRET_BEFORE_DEPLOYMENT',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, maxAge: '1d' }));
importLegacyClockData();

const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`)
});
const upload = multer({ storage: imageStorage, limits: { fileSize: 8 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) });
const submissionUpload = multer({ storage:imageStorage, limits:{fileSize:100*1024*1024,files:1}, fileFilter:(_req,file,cb)=>cb(null,/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime|x-matroska))$/.test(file.mimetype)) });

let client = null;
let botReady = false;
let botLastError = null;

function getGuild() { return client && GUILD_ID ? client.guilds.cache.get(GUILD_ID) : null; }
function userRoleIds(req) {
  if (!req.session?.user?.id) return [];
  const member = readUser(req.session.user.id);
  return member?.in_guild ? JSON.parse(member.role_ids || '[]') : [];
}
function getAccess(req) {
  const userId = req.session?.user?.id;
  if (!userId) return { authenticated: false, inGuild: false, roles: [], permissions: [] };
  const mapping = roleMappings();
  const roles = userRoleIds(req);
  const has = key => Boolean(mapping[key] && roles.includes(mapping[key]));
  const bootstrap = userId === BOOTSTRAP_ID;
  const owner = bootstrap || has('owner');
  const boss = owner || has('boss') || has('coboss');
  const leader = boss || has('leader');
  const permissions = new Set(['profile:read']);
  if (readUser(userId)?.in_guild) permissions.add('member:basic');
  if (owner) ['admin:all','settings:write','roles:manage','members:manage','tasks:manage','resources:manage','guns:manage','announcements:send','tickets:manage','logs:read','clock:manage','media:manage'].forEach(x => permissions.add(x));
  if (boss) ['dashboard:read','settings:write','roles:manage','leaderboard:read','members:read','members:manage','tasks:manage','resources:manage','guns:manage','announcements:send','tickets:manage','logs:read','clock:manage','media:manage','settings:read'].forEach(x => permissions.add(x));
  if (leader) ['dashboard:read','members:read','tasks:read','resources:read','guns:read','leaderboard:read'].forEach(x => permissions.add(x));
  const scoped = [
    ['memberManager','members:read','members:manage'], ['taskManager','tasks:read','tasks:manage'],
    ['resourceManager','resources:read','resources:manage'], ['armoryManager','guns:read','guns:manage'],
    ['mediaManager','media:read','media:manage'], ['ticketManager','tickets:read','tickets:manage'],
    ['logsViewer','logs:read'], ['clockManager','clock:read','clock:manage']
  ];
  for (const [key, ...perms] of scoped) if (has(key)) perms.forEach(x => permissions.add(x));
  if (has('gang')) { permissions.add('members:read'); permissions.add('leaderboard:read'); permissions.add('media:read'); }
  return { authenticated: true, inGuild: Boolean(readUser(userId)?.in_guild), roles, roleNames: Object.entries(mapping).filter(([k,v]) => v && roles.includes(v)).map(([k]) => k), permissions: [...permissions], isBootstrapOwner: bootstrap };
}
function hasPermission(req, permission) { return getAccess(req).permissions.includes('admin:all') || getAccess(req).permissions.includes(permission); }
function requireAuth(req, res, next) {
  if (!req.session?.user?.id) return res.status(401).json({ error: 'LOGIN_REQUIRED', message: 'Log in with Discord first.' });
  next();
}
function requireGuild(req, res, next) {
  const member = readUser(req.session.user.id);
  if (!member?.in_guild) return res.status(403).json({ error: 'NOT_IN_GUILD', message: 'Your Discord account is not a member of the configured server.' });
  next();
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req, permission)) {
      insertLog({ actorId: req.session?.user?.id, actorName: req.session?.user?.username, action: 'access.denied', targetType: 'route', targetId: req.path, result: 'denied', req, details: { required: permission } });
      return res.status(403).json({ error: 'FORBIDDEN', message: `Missing permission: ${permission}` });
    }
    next();
  };
}
async function syncGuildMember(member) {
  if (!member?.user) return;
  const roles = member.roles?.cache ? [...member.roles.cache.keys()].filter(id => id !== member.guild.id) : [];
  db.prepare(`INSERT INTO discord_members(user_id,username,global_name,avatar,role_ids,in_guild,synced_at)
    VALUES(?,?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,global_name=excluded.global_name,avatar=excluded.avatar,role_ids=excluded.role_ids,in_guild=1,synced_at=excluded.synced_at`)
    .run(member.id, member.user.username, member.user.globalName || null, member.user.displayAvatarURL({ extension: 'png', size: 128 }), JSON.stringify(roles), nowIso());
}
async function syncGuildMembers() {
  const guild = getGuild();
  if (!guild) return;
  try {
    const fetched = await guild.members.fetch();
    const tx = db.transaction(members => {
      db.prepare('UPDATE discord_members SET in_guild=0,synced_at=?').run(nowIso());
      for (const member of members.values()) {
        const roles = [...member.roles.cache.keys()].filter(id => id !== guild.id);
        db.prepare(`INSERT INTO discord_members(user_id,username,global_name,avatar,role_ids,in_guild,synced_at)
          VALUES(?,?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,global_name=excluded.global_name,avatar=excluded.avatar,role_ids=excluded.role_ids,in_guild=1,synced_at=excluded.synced_at`)
          .run(member.id, member.user.username, member.user.globalName || null, member.user.displayAvatarURL({ extension: 'png', size: 128 }), JSON.stringify(roles), nowIso());
      }
    });
    tx(fetched);
    console.log(`[Discord] Synced ${fetched.size} guild members and their role IDs.`);
  } catch (error) {
    botLastError = error.message;
    console.error('[Discord] Member sync failed:', error.message);
  }
}
function isEligibleForClock(member) {
  const mapping = roleMappings();
  const allowed = ['owner','boss','coboss','leader','gang'].map(key => mapping[key]).filter(Boolean);
  return Boolean(allowed.length && member?.roles?.cache && allowed.some(roleId => member.roles.cache.has(roleId)));
}
function hasActivity(member) {
  const expected = String(botSettings().activityName || 'Kayan CFW').trim().toLowerCase();
  if (!expected) return false;
  return (member?.presence?.activities || []).some(activity => `${activity.name || ''} ${activity.state || ''} ${activity.details || ''}`.toLowerCase().includes(expected));
}
function periodKey(date, kind) {
  const value = moment(date).tz(TIMEZONE);
  return kind === 'month' ? value.format('YYYY-MM') : value.format('GGGG-[w]WW');
}
function shiftTotals(userId, kind = 'alltime') {
  const legacy = kind === 'alltime'
    ? (db.prepare("SELECT COALESCE(SUM(minutes),0) AS total FROM legacy_clock_totals WHERE user_id=? AND kind='alltime'").get(userId)?.total || 0)
    : (kind === 'week' || kind === 'month')
      ? (db.prepare('SELECT COALESCE(SUM(minutes),0) AS total FROM legacy_clock_totals WHERE user_id=? AND kind=? AND period=?').get(userId, kind, periodKey(new Date(), kind))?.total || 0)
      : 0;
  const adjustment = kind === 'alltime'
    ? (db.prepare("SELECT COALESCE(SUM(minutes),0) AS total FROM clock_adjustments WHERE user_id=? AND kind='alltime'").get(userId)?.total || 0)
    : (kind === 'week' || kind === 'month')
      ? (db.prepare('SELECT COALESCE(SUM(minutes),0) AS total FROM clock_adjustments WHERE user_id=? AND kind=? AND period=?').get(userId, kind, periodKey(new Date(), kind))?.total || 0)
      : 0;
  const shifts = db.prepare('SELECT started_at, ended_at FROM shifts WHERE user_id = ? AND ended_at IS NOT NULL').all(userId);
  const now = Date.now();
  const startOf = (date, unit) => moment(date).tz(TIMEZONE).startOf(unit === 'month' ? 'month' : 'week').valueOf();
  let threshold = 0;
  if (kind === 'week') threshold = startOf(new Date(now), 'week');
  if (kind === 'month') threshold = startOf(new Date(now), 'month');
  let seconds = 0;
  for (const s of shifts) seconds += Math.max(0, Math.floor((s.ended_at - Math.max(s.started_at, threshold)) / 1000));
  const active = db.prepare('SELECT started_at FROM shifts WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(userId);
  if (active) seconds += Math.max(0, Math.floor((now - Math.max(active.started_at, threshold)) / 1000));
  return Math.max(0, legacy + adjustment + Math.floor(seconds / 60));
}
async function refreshClockPanel() {
  if (!client?.isReady()) return;
  const settings = botSettings();
  if (!settings.clockChannelId) return;
  try {
    const channel = await client.channels.fetch(settings.clockChannelId);
    if (!channel?.isTextBased()) return;
    const saved = readSetting('clockPanelMessageId', '');
    const activeShifts = db.prepare('SELECT user_id,started_at FROM shifts WHERE ended_at IS NULL ORDER BY started_at').all();
    const onDuty = activeShifts.length ? activeShifts.map(s => `<@${s.user_id}>`).join('\n').slice(0,1000) : 'No active shifts';
    const embed = new EmbedBuilder().setColor(0x151518).setTitle('ANARCHY | ACTIVITY STATUS').setDescription('Use the buttons below to start or end your activity shift. FiveM activity is checked by Discord Presence.').addFields({ name:`ON DUTY · ${activeShifts.length}`, value:onDuty }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('an_clock_in').setLabel('Clock In').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('an_clock_out').setLabel('Clock Out').setStyle(ButtonStyle.Danger)
    );
    let message;
    if (saved) message = await channel.messages.fetch(saved).catch(() => null);
    if (message) await message.edit({ embeds: [embed], components: [row] });
    else { message = await channel.send({ embeds: [embed], components: [row] }); writeSetting('clockPanelMessageId', message.id); }
  } catch (error) { botLastError = error.message; console.error('[Clock] Could not refresh panel:', error.message); }
}
async function refreshLeaderboardPanel(period = readSetting('leaderboardPeriod', 'alltime')) {
  if (!client?.isReady()) return;
  const channelId = botSettings().leaderboardChannelId;
  if (!channelId) return;
  const periodName = ['alltime','week','month'].includes(period) ? period : 'alltime';
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    const totals = db.prepare('SELECT user_id,username,global_name,avatar FROM discord_members WHERE in_guild=1').all()
      .map(member => ({ ...member, minutes: shiftTotals(member.user_id, periodName) }))
      .sort((a,b) => b.minutes-a.minutes).slice(0,15);
    const title = periodName === 'alltime' ? 'ALL-TIME ACTIVITY' : periodName === 'week' ? `WEEKLY ACTIVITY · ${periodKey(new Date(),'week')}` : `MONTHLY ACTIVITY · ${periodKey(new Date(),'month')}`;
    const description = totals.length ? totals.map((member,index) => {
      const medal = ['🥇','🥈','🥉'][index] || `#${index+1}`;
      return `${medal} <@${member.user_id}> — **${Math.floor(member.minutes/60)}h ${member.minutes%60}m**`;
    }).join('\n') : 'No activity recorded yet.';
    const embed = new EmbedBuilder().setColor(0xED2434).setTitle(`ANARCHY | ${title}`).setDescription(description).setFooter({ text:'Activity is calculated from recorded shifts · Africa/Cairo' }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('an_lb_alltime').setLabel('All Time').setStyle(periodName==='alltime'?ButtonStyle.Danger:ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('an_lb_week').setLabel('Weekly').setStyle(periodName==='week'?ButtonStyle.Danger:ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('an_lb_month').setLabel('Monthly').setStyle(periodName==='month'?ButtonStyle.Danger:ButtonStyle.Secondary)
    );
    const saved = readSetting('leaderboardPanelMessageId','');
    let message = saved ? await channel.messages.fetch(saved).catch(() => null) : null;
    if (message) await message.edit({ embeds:[embed], components:[row] });
    else { message = await channel.send({ embeds:[embed], components:[row] }); writeSetting('leaderboardPanelMessageId', message.id); }
    writeSetting('leaderboardPeriod', periodName);
  } catch (error) { botLastError = error.message; console.error('[Leaderboard]', error.message); }
}

async function sendLogEmbed(title, fields, color = 0xED2434) {
  if (!client?.isReady()) return;
  const channelId = botSettings().logChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).addFields(fields).setTimestamp()] }).catch(err => console.error('[Discord log]', err.message));
}
async function sendTaskNotification(title, fields, color = 0xED2434) {
  if (!client?.isReady()) return;
  const channelId = botSettings().taskChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).addFields(fields).setTimestamp()] })
    .catch(err => console.error('[Discord task notification]', err.message));
}
async function closeShift(userId, source = 'discord') {
  const active = db.prepare('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(userId);
  if (!active) return null;
  const ended = Date.now();
  const seconds = Math.max(0, Math.floor((ended - active.started_at) / 1000));
  db.prepare('UPDATE shifts SET ended_at=?,duration_seconds=?,end_source=? WHERE id=?').run(ended, seconds, source, active.id);
  insertLog({ actorId: userId, actorName: readUser(userId)?.username || userId, action: 'clock.out', targetType: 'shift', targetId: String(active.id), details: { seconds, source } });
  await sendLogEmbed('ANARCHY | CLOCK OUT', [
    { name: 'Member', value: `<@${userId}>`, inline: true },
    { name: 'Duration', value: `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`, inline: true },
    { name: 'Source', value: source, inline: true }
  ], 0x8B1D2C);
  await refreshClockPanel(); await refreshLeaderboardPanel();
  return { ...active, ended_at: ended, duration_seconds: seconds };
}
async function startShift(userId, source = 'discord') {
  const active = db.prepare('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL').get(userId);
  if (active) return { error: 'ALREADY_CLOCKED_IN' };
  const started = Date.now();
  const result = db.prepare('INSERT INTO shifts(user_id,started_at,start_source,created_at) VALUES(?,?,?,?)').run(userId, started, source, nowIso());
  insertLog({ actorId: userId, actorName: readUser(userId)?.username || userId, action: 'clock.in', targetType: 'shift', targetId: String(result.lastInsertRowid), details: { source } });
  await sendLogEmbed('ANARCHY | CLOCK IN', [{ name: 'Member', value: `<@${userId}>` }, { name: 'Source', value: source }], 0x247A50);
  await refreshClockPanel(); await refreshLeaderboardPanel();
  return { id: Number(result.lastInsertRowid), started_at: started };
}

// ---- Discord OAuth ----
app.get('/auth/discord', (req, res) => {
  const { DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) return res.status(503).send('Discord OAuth is not configured. Fill DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI in backend/.env.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify' , state });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid Discord OAuth state. Please restart login.');
    delete req.session.oauthState;
    const body = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID || '', client_secret: process.env.DISCORD_CLIENT_SECRET || '', grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: process.env.DISCORD_REDIRECT_URI || '' });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) throw new Error('Discord token exchange failed. Check OAuth application settings.');
    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) throw new Error('Could not read Discord user profile.');
    req.session.user = { id: user.id, username: user.username, globalName: user.global_name || user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null };
    if (client?.isReady() && GUILD_ID) {
      const guild = getGuild();
      const member = await guild?.members.fetch({ user: user.id, force: true }).catch(() => null);
      if (member) await syncGuildMember(member);
      else db.prepare(`INSERT INTO discord_members(user_id,username,global_name,avatar,role_ids,in_guild,synced_at) VALUES(?,?,?,?, '[]',0,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,global_name=excluded.global_name,avatar=excluded.avatar,in_guild=0,synced_at=excluded.synced_at`).run(user.id, user.username, user.global_name || null, req.session.user.avatar, nowIso());
    }
    insertLog({ actorId: user.id, actorName: user.username, action: 'auth.login', targetType: 'user', targetId: user.id, req });
    req.session.save(() => res.redirect(`${FRONTEND_URL.replace(/\/$/, '')}/#home?login=success`));
  } catch (error) {
    console.error('[OAuth]', error.message);
    res.status(502).send(`Discord login failed: ${error.message}`);
  }
});
app.post('/auth/logout', (req, res) => {
  const user = req.session?.user;
  if (user) insertLog({ actorId: user.id, actorName: user.username, action: 'auth.logout', targetType: 'user', targetId: user.id, req });
  req.session.destroy(() => { res.clearCookie('anarchy.sid'); res.json({ success: true }); });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'anarchy-backend', bot: botReady ? 'online' : 'offline', guildConfigured: Boolean(GUILD_ID), lastBotError: botLastError, time: nowIso() }));
app.get('/api/auth/me', (req, res) => {
  const access = getAccess(req);
  const user = req.session?.user || null;
  res.json({ user, access, member: user ? readUser(user.id) || null : null, authConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI), bot: { online: botReady, guildConfigured: Boolean(GUILD_ID) } });
});
app.get('/api/settings', requireAuth, requireGuild, requirePermission('settings:read'), (_req, res) => res.json({ roleMappings: roleMappings(), botSettings: botSettings() }));

// Live Discord configuration choices. IDs stay on the backend; the UI displays readable names.
app.get('/api/discord/config-options', requireAuth, requireGuild, requirePermission('settings:read'), async (_req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'BOT_OFFLINE' });
  const guild = getGuild();
  if (!guild) return res.status(503).json({ error: 'GUILD_NOT_AVAILABLE' });
  try {
    const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    res.set('Cache-Control', 'no-store').json({
      roles: [...roles.values()].filter(role => role && role.id !== guild.id).sort((a,b) => b.position-a.position).map(role => ({ id: role.id, name: role.name, position: role.position, color: role.hexColor })),
      channels: [...channels.values()].filter(channel => channel && channel.type !== 4 && channel.isTextBased?.()).map(channel => ({ id: channel.id, name: channel.name || channel.id, type: channel.type, parentId: channel.parentId || null })).sort((a,b) => String(a.name).localeCompare(String(b.name))),
      categories: [...channels.values()].filter(channel => channel && channel.type === 4).map(channel => ({ id: channel.id, name: channel.name })).sort((a,b) => a.name.localeCompare(b.name)),
      guild: { id: guild.id, name: guild.name }
    });
  } catch (error) { res.status(502).json({ error: 'DISCORD_OPTIONS_FETCH_FAILED', message: error.message }); }
});
app.patch('/api/settings', requireAuth, requireGuild, requirePermission('settings:write'), (req, res) => {
  const input = req.body || {};
  if (input.roleMappings) {
    const currentRoleMappings = roleMappings();
    if (!hasPermission(req, 'admin:all') && (
      (input.roleMappings.owner !== undefined && String(input.roleMappings.owner || '').trim() !== currentRoleMappings.owner) ||
      (input.roleMappings.boss !== undefined && String(input.roleMappings.boss || '').trim() !== currentRoleMappings.boss)
    )) return res.status(403).json({ error:'OWNER_ROLE_CONFIGURATION_REQUIRES_OWNER' });
    const clean = { ...currentRoleMappings };
    for (const key of Object.keys(DEFAULT_ROLES)) {
      if (input.roleMappings[key] !== undefined) {
        const value = String(input.roleMappings[key] || '').trim();
        if (value && !/^\d{17,20}$/.test(value)) return res.status(400).json({ error: 'INVALID_ROLE_ID', field: key });
        clean[key] = value;
      }
    }
    writeSetting('roleMappings', clean);
  }
  if (input.botSettings) {
    const allowed = ['activityName','clockChannelId','logChannelId','taskChannelId','leaderboardChannelId','supportCategoryId','ticketLogChannelId','announcementChannelId','clipRequestChannelId','galleryRequestChannelId'];
    const clean = { ...botSettings() };
    for (const key of allowed) if (input.botSettings[key] !== undefined) {
      const value = String(input.botSettings[key] || '').trim();
      if (key !== 'activityName' && value && !/^\d{17,20}$/.test(value)) return res.status(400).json({ error: 'INVALID_DISCORD_ID', field: key });
      clean[key] = value;
    }
    writeSetting('botSettings', clean);
  }
  insertLog({ actorId: req.session.user.id, actorName: req.session.user.username, action: 'settings.updated', targetType: 'settings', req, details: { keys: Object.keys(input) } });
  refreshClockPanel().catch(() => {});
  res.json({ success: true, roleMappings: roleMappings(), botSettings: botSettings() });
});

app.get('/api/public/content/:type', (req,res)=>{const collection=req.params.type==='clips'?'clips':req.params.type==='gallery'?'gallery':null;if(!collection)return res.status(400).json({error:'INVALID_TYPE'});const items=db.prepare('SELECT id,data,created_at FROM records WHERE collection=? ORDER BY created_at DESC').all(collection).map(row=>({...JSON.parse(row.data),id:row.id,createdAt:row.created_at})).filter(item=>item.status==='published');res.json({items});});

app.get('/api/public/media', (_req, res) => {
  const items = db.prepare("SELECT id,data,created_at,updated_at FROM records WHERE collection='mediaLinks' ORDER BY created_at DESC").all().map(row => ({ id:row.id, ...JSON.parse(row.data), createdAt:row.created_at, updatedAt:row.updated_at })).filter(item => item.status !== 'pending' && ['kick','tiktok','youtube'].includes(item.platform) && /^https:\/\//i.test(String(item.url || '')));
  res.json({ items });
});

app.get('/api/public/members', (_req, res) => {
  const mapping = roleMappings();
  const publicRoleKeys = ['boss','coboss','leader','gang'];
  const allowedRoleIds = new Set(publicRoleKeys.map(key => mapping[key]).filter(Boolean));
  if (!allowedRoleIds.size) return res.json({ members: [] });
  const rows = db.prepare('SELECT user_id,username,global_name,avatar,role_ids FROM discord_members WHERE in_guild=1').all();
  const rank = { boss:0, coboss:1, leader:2, gang:3 };
  const members = rows.map(member => {
    const ids = JSON.parse(member.role_ids || '[]');
    const role = publicRoleKeys.filter(key => mapping[key] && ids.includes(mapping[key])).sort((a,b) => rank[a]-rank[b])[0];
    return role ? { ...member, role: role === 'coboss' ? 'Co-Boss' : role === 'gang' ? 'AC Gang' : role.charAt(0).toUpperCase()+role.slice(1) } : null;
  }).filter(Boolean).map(({role_ids, ...member}) => member).sort((a,b) => rank[({Boss:'boss','Co-Boss':'coboss',Leader:'leader','AC Gang':'gang'})[a.role]] - rank[({Boss:'boss','Co-Boss':'coboss',Leader:'leader','AC Gang':'gang'})[b.role]]);
  const overrides = db.prepare("SELECT id,data FROM records WHERE collection='memberProfiles'").all();
  const overrideMap = new Map(overrides.map(row => [String(row.id), JSON.parse(row.data)]));
  const merged = members.map(member => { const custom=overrideMap.get(String(member.user_id)); return custom ? { ...member, global_name:custom.name || member.global_name, avatar:custom.image || member.avatar, role:custom.role || member.role } : member; });
  res.json({ members:merged });
});


app.get('/api/tasks/assignable-members', requireAuth, requireGuild, requirePermission('tasks:manage'), (req, res) => {
  const gangRoleId = roleMappings().gang;
  if (!gangRoleId) return res.json({ members: [], warning: 'Configure the AC Gang role ID in Settings first.' });
  const members = db.prepare('SELECT user_id,username,global_name,avatar,role_ids FROM discord_members WHERE in_guild=1 ORDER BY COALESCE(global_name,username) COLLATE NOCASE').all()
    .filter(member => JSON.parse(member.role_ids || '[]').includes(gangRoleId))
    .map(({ role_ids, ...member }) => member);
  res.json({ members });
});

app.get('/api/discord/members', requireAuth, requireGuild, requirePermission('members:read'), (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const rows = db.prepare(`SELECT user_id,username,global_name,avatar,role_ids,in_guild,synced_at FROM discord_members ORDER BY in_guild DESC, COALESCE(global_name,username) COLLATE NOCASE`).all()
    .filter(m => !q || `${m.username} ${m.global_name || ''} ${m.user_id}`.toLowerCase().includes(q))
    .map(m => ({ ...m, role_ids: JSON.parse(m.role_ids || '[]'), roleNames: Object.entries(roleMappings()).filter(([key,id]) => id && JSON.parse(m.role_ids || '[]').includes(id)).map(([key]) => key) }));
  res.json({ members: rows, syncedAt: rows.reduce((max,m) => m.synced_at > max ? m.synced_at : max, '') || null });
});
app.post('/api/discord/sync', requireAuth, requireGuild, requirePermission('roles:manage'), async (req, res) => {
  await syncGuildMembers();
  insertLog({ actorId: req.session.user.id, actorName: req.session.user.username, action: 'discord.members.sync', targetType: 'guild', targetId: GUILD_ID, req });
  res.json({ success: true, syncedAt: nowIso() });
});
app.post('/api/discord/members/:userId/roles', requireAuth, requireGuild, requirePermission('roles:manage'), async (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'BOT_OFFLINE' });
  const { roleId, action } = req.body || {};
  if (!/^\d{17,20}$/.test(String(roleId || '')) || !['add','remove'].includes(action)) return res.status(400).json({ error: 'INVALID_ROLE_ACTION' });
  const mapping = roleMappings();
  const privileged = new Set([mapping.owner,mapping.boss,mapping.coboss].filter(Boolean));
  if (privileged.has(roleId) && !hasPermission(req, 'admin:all')) return res.status(403).json({ error: 'PRIVILEGED_ROLE' });
  try {
    const guild = getGuild();
    const member = await guild.members.fetch(req.params.userId);
    const role = await guild.roles.fetch(roleId);
    if (!role) return res.status(404).json({ error: 'ROLE_NOT_FOUND' });
    if (action === 'add') await member.roles.add(role, `ANARCHY site action by ${req.session.user.username}`);
    else await member.roles.remove(role, `ANARCHY site action by ${req.session.user.username}`);
    await syncGuildMember(member);
    insertLog({ actorId: req.session.user.id, actorName: req.session.user.username, action: `discord.role.${action}`, targetType: 'member', targetId: member.id, details: { roleId, roleName: role.name }, req });
    await sendLogEmbed(`ANARCHY | ROLE ${action.toUpperCase()}`, [{ name: 'Member', value: `<@${member.id}>` }, { name: 'Role', value: `<@&${roleId}>` }, { name: 'By', value: `<@${req.session.user.id}>` }]);
    res.json({ success: true, member: { id: member.id, roles: [...member.roles.cache.keys()] } });
  } catch (error) {
    insertLog({ actorId: req.session.user.id, actorName: req.session.user.username, action: `discord.role.${action}`, targetType: 'member', targetId: req.params.userId, result: 'failed', details: { roleId, error: error.message }, req });
    res.status(400).json({ error: 'DISCORD_ROLE_OPERATION_FAILED', message: error.message });
  }
});

app.get('/api/clock/shifts', requireAuth, requireGuild, requirePermission('clock:manage'), (req, res) => {
  const active = db.prepare('SELECT user_id,started_at,start_source FROM shifts WHERE ended_at IS NULL ORDER BY started_at').all();
  const recent = db.prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT 200').all();
  res.json({ active: active.map(s => ({ ...s, elapsedSeconds: Math.max(0, Math.floor((Date.now() - s.started_at) / 1000)), member: readUser(s.user_id) })), recent });
});
app.post('/api/clock/adjust', requireAuth, requireGuild, requirePermission('clock:manage'), (req, res) => {
  const userId = String(req.body?.userId || '');
  const minutes = Math.trunc(Number(req.body?.minutes));
  const period = String(req.body?.period || 'alltime');
  const reason = String(req.body?.reason || '').trim().slice(0,300);
  if (!/^\d{17,20}$/.test(userId) || !Number.isFinite(minutes) || minutes === 0 || Math.abs(minutes) > 100000 || !['alltime','week','month'].includes(period) || !reason) return res.status(400).json({ error:'INVALID_CLOCK_ADJUSTMENT' });
  const periodValue = period === 'alltime' ? '' : periodKey(new Date(), period);
  db.prepare('INSERT INTO clock_adjustments(user_id,kind,period,minutes,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(userId, period, periodValue, minutes, reason, req.session.user.id, nowIso());
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'clock.hours.adjusted', targetType:'member', targetId:userId, details:{ minutes, period, reason }, req });
  res.json({ success:true, minutes, period });
});

const COLLECTION_PERMISSIONS = {
  members: ['members:read','members:manage'], categories: ['members:read','members:manage'], tasks: ['tasks:read','tasks:manage'], taskTemplates: ['tasks:read','tasks:manage'], resources: ['resources:read','resources:manage'],
  guns: ['guns:read','guns:manage'], gunModels: ['guns:read','guns:manage'], gunStock: ['guns:read','guns:manage'], media: ['media:read','media:manage'], mediaLinks: ['media:read','media:manage'], memberProfiles:['members:read','members:manage'], clips: ['media:read','media:manage'], gallery: ['media:read','media:manage'], clipRequests:['media:read','media:manage'], galleryRequests:['media:read','media:manage']
};
app.get('/api/data/:collection', requireAuth, requireGuild, (req, res) => {
  const [readPermission] = COLLECTION_PERMISSIONS[req.params.collection] || [];
  if (!readPermission) return res.status(404).json({ error: 'UNKNOWN_COLLECTION' });
  if (!hasPermission(req, readPermission) && !hasPermission(req, 'admin:all')) return res.status(403).json({ error: 'FORBIDDEN' });
  const rows = db.prepare('SELECT id,data,created_by,created_at,updated_at FROM records WHERE collection=? ORDER BY created_at DESC').all(req.params.collection).map(r => ({ id:r.id, ...JSON.parse(r.data), createdBy:r.created_by, createdAt:r.created_at, updatedAt:r.updated_at }));
  res.json({ items: rows });
});
app.post('/api/data/:collection', requireAuth, requireGuild, (req, res) => {
  const permissions = COLLECTION_PERMISSIONS[req.params.collection];
  if (!permissions) return res.status(404).json({ error: 'UNKNOWN_COLLECTION' });
  if (!hasPermission(req, permissions[1]) && !hasPermission(req, 'admin:all')) return res.status(403).json({ error: 'FORBIDDEN' });
  const data = req.body || {};
  if (['tasks','resources'].includes(req.params.collection) && !data.image && !data.proofImage) return res.status(400).json({ error: 'PROOF_IMAGE_REQUIRED' });
  const id = String(data.id || crypto.randomUUID());
  const time = nowIso();
  const prior = db.prepare('SELECT data,created_by,created_at FROM records WHERE id=? AND collection=?').get(id, req.params.collection);
  if (req.params.collection === 'tasks' && !prior) {
    const templateId = String(data.templateId || '');
    const template = templateId ? db.prepare("SELECT id FROM records WHERE id=? AND collection='taskTemplates'").get(templateId) : null;
    if (!template) return res.status(400).json({ error:'TASK_PRESET_REQUIRED', message:'Choose a saved task preset before creating a task.' });
    const assigneeId = String(data.assignee || '');
    if (!/^\d{17,20}$/.test(assigneeId)) return res.status(400).json({ error:'INVALID_ASSIGNEE', message:'Choose a valid Discord member.' });
    const assignee = db.prepare('SELECT role_ids,in_guild FROM discord_members WHERE user_id=?').get(assigneeId);
    const gangRoleId = roleMappings().gang;
    if (!assignee || !assignee.in_guild || !gangRoleId || !JSON.parse(assignee.role_ids || '[]').includes(gangRoleId)) {
      return res.status(400).json({ error:'ASSIGNEE_NOT_GANG_MEMBER', message:'The selected assignee must be a synced in-guild member with the configured AC Gang role.' });
    }
  }
  let priorData = {};
  try { priorData = prior?.data ? JSON.parse(prior.data) : {}; } catch {}
  const actorName = req.session.user.globalName || req.session.user.username;
  const enriched = {
    ...data,
    id,
    ...(['tasks','taskTemplates'].includes(req.params.collection) ? {
      createdBy: priorData.createdBy || prior?.created_by || req.session.user.id,
      createdByName: priorData.createdByName || actorName
    } : {})
  };
  db.prepare(`INSERT INTO records(id,collection,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE records.collection=excluded.collection`).run(id, req.params.collection, JSON.stringify(enriched), prior?.created_by || req.session.user.id, prior?.created_at || time, time);
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.globalName || req.session.user.username, action:`${req.params.collection}.saved`, targetType:req.params.collection, targetId:id, details:{ name:data.name || data.title || null, createdByName:enriched.createdByName || null, assigneeName:enriched.assigneeName || null }, req });
  if (['tasks','taskTemplates'].includes(req.params.collection)) void sendTaskNotification(`ANARCHY | ${req.params.collection === 'tasks' ? 'TASK CREATED / UPDATED' : 'TASK PRESET SAVED'}`, [{ name:'Item', value:String(data.title || data.name || 'Untitled').slice(0,256) }, { name:'Created by', value:`<@${req.session.user.id}>` }, ...(data.assignee ? [{ name:'Assigned to', value:/^\d{17,20}$/.test(String(data.assignee)) ? `<@${data.assignee}>` : String(data.assignee).slice(0,256) }] : [])]);
  res.json({ success:true, id });
});
app.delete('/api/data/:collection/:id', requireAuth, requireGuild, (req, res) => {
  const permissions = COLLECTION_PERMISSIONS[req.params.collection];
  if (!permissions) return res.status(404).json({ error:'UNKNOWN_COLLECTION' });
  if (!hasPermission(req, permissions[1]) && !hasPermission(req, 'admin:all')) return res.status(403).json({ error:'FORBIDDEN' });
  const existing = db.prepare('SELECT data FROM records WHERE id=? AND collection=?').get(req.params.id, req.params.collection);
  if (!existing) return res.status(404).json({ error:'NOT_FOUND' });
  db.prepare('DELETE FROM records WHERE id=? AND collection=?').run(req.params.id, req.params.collection);
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:`${req.params.collection}.deleted`, targetType:req.params.collection, targetId:req.params.id, details:{ name:JSON.parse(existing.data).name || JSON.parse(existing.data).title || null, imageAttached:Boolean(JSON.parse(existing.data).image || JSON.parse(existing.data).proofImage), collection:req.params.collection }, req });
  res.json({ success:true });
});

app.post('/api/uploads/image', requireAuth, requireGuild, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'IMAGE_REQUIRED_OR_INVALID' });
  const url = `/uploads/${req.file.filename}`;
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'file.uploaded', targetType:'image', targetId:req.file.filename, details:{ size:req.file.size, mime:req.file.mimetype }, req });
  res.status(201).json({ success:true, url, filename:req.file.filename, size:req.file.size });
});


function hasMappedGangRole(req) { const mapping=roleMappings(); const ids=userRoleIds(req); return Boolean(mapping.gang && ids.includes(mapping.gang)); }
function canReviewSubmissions(req) { return hasPermission(req,'media:manage') || hasPermission(req,'admin:all'); }
app.post('/api/submissions', requireAuth, requireGuild, submissionUpload.single('file'), async (req,res) => {
  const type=String(req.body.type||''); if(!['clip','gallery'].includes(type)) return res.status(400).json({error:'INVALID_SUBMISSION_TYPE'});
  if(!hasMappedGangRole(req) && !canReviewSubmissions(req)) { if(req.file) fs.unlink(req.file.path,()=>{}); return res.status(403).json({error:'GANG_ROLE_REQUIRED',message:'Only AC Gang members can submit public clips and photos.'}); }
  if(!req.file) return res.status(400).json({error:'FILE_REQUIRED'});
  if(type==='clip' && !req.file.mimetype.startsWith('video/')) return res.status(400).json({error:'VIDEO_REQUIRED'});
  if(type==='gallery' && !req.file.mimetype.startsWith('image/')) return res.status(400).json({error:'IMAGE_REQUIRED'});
  const id=crypto.randomUUID(); const item={id,type,filename:req.file.filename,url:`/uploads/${req.file.filename}`,mime:req.file.mimetype,originalName:req.file.originalname,submitterId:req.session.user.id,submitterName:req.session.user.globalName||req.session.user.username,status:'pending',createdAt:nowIso()};
  const time=nowIso(); db.prepare('INSERT INTO records(id,collection,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,type==='clip'?'clipRequests':'galleryRequests',JSON.stringify(item),req.session.user.id,time,time);
  insertLog({actorId:req.session.user.id,actorName:item.submitterName,action:`${type}.request.submitted`,targetType:type,targetId:id,details:{filename:item.originalName},req});
  try { const settings=botSettings(); const channelId=type==='clip'?settings.clipRequestChannelId:settings.galleryRequestChannelId; if(client?.isReady() && channelId) { const channel=await client.channels.fetch(channelId); if(channel?.isTextBased()) { const mapping=roleMappings(); const mentions=[mapping.owner,mapping.boss,mapping.coboss].filter(Boolean).map(role=>`<@&${role}>`).join(' '); const publicBase=(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/,''); const url=`${publicBase}${item.url}`; const embed=new EmbedBuilder().setColor('#ED2434').setTitle(`ANARCHY | ${type.toUpperCase()} REQUEST`).setDescription(`**From:** <@${item.submitterId}>\n**File:** ${item.originalName}\n**Request ID:** \`${id}\``).addFields({name:'Review',value:'Use the buttons below or review this request in the website dashboard.'}).setTimestamp(); const attachmentName=`anarchy-request-${path.basename(item.filename)}`; if(type==='gallery') embed.setImage(`attachment://${attachmentName}`); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`an_submission_approve:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`an_submission_reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)); await channel.send({content:mentions || `<@${item.submitterId}>`,embeds:[embed],files:[{attachment:path.join(UPLOAD_DIR,path.basename(item.filename)),name:attachmentName}],components:[row]}); } } } catch(error){console.error('[Submission notify]',error.message);}
  res.status(201).json({success:true,id,status:'pending'});
});
app.get('/api/submissions', requireAuth, requireGuild, (req,res)=>{ if(!canReviewSubmissions(req))return res.status(403).json({error:'FORBIDDEN'}); const rows=db.prepare("SELECT id,collection,data,created_at FROM records WHERE collection IN ('clipRequests','galleryRequests') ORDER BY created_at DESC").all().map(row=>({...JSON.parse(row.data),id:row.id,collection:row.collection})); res.json({items:rows}); });
app.post('/api/submissions/:id/review', requireAuth, requireGuild, async (req,res)=>{
  if(!canReviewSubmissions(req)) return res.status(403).json({error:'FORBIDDEN'});
  const action=String(req.body.action||'');
  if(!['approve','reject'].includes(action)) return res.status(400).json({error:'INVALID_ACTION'});
  const row=db.prepare("SELECT collection,data FROM records WHERE id=? AND collection IN ('clipRequests','galleryRequests')").get(req.params.id);
  if(!row) return res.status(404).json({error:'NOT_FOUND'});
  const item=JSON.parse(row.data);
  if(item.status!=='pending') return res.status(409).json({error:'ALREADY_REVIEWED'});
  const reviewedAt=nowIso();
  item.status=action==='approve'?'approved':'rejected'; item.reviewedBy=req.session.user.id; item.reviewedAt=reviewedAt;
  const publicCollection=row.collection==='clipRequests'?'clips':'gallery';
  try {
    const tx=db.transaction(()=>{
      if(action==='approve') {
        // IDs are globally unique across collections, so published media gets a new ID.
        const publishedId=crypto.randomUUID();
        const published={...item,id:publishedId,title:item.originalName,name:item.originalName,image:item.type==='gallery'?item.url:'',url:item.url,video:item.type==='clip'?item.url:'',status:'published',sourceRequestId:item.id};
        db.prepare('INSERT INTO records(id,collection,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(publishedId,publicCollection,JSON.stringify(published),item.submitterId,item.createdAt,reviewedAt);
      }
      db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=? AND collection=?').run(JSON.stringify(item),reviewedAt,req.params.id,row.collection);
      insertLog({actorId:req.session.user.id,actorName:req.session.user.username,action:`${item.type}.request.${action}`,targetType:item.type,targetId:item.id,details:{submitterId:item.submitterId,filename:item.originalName},req});
    });
    tx(); res.json({success:true,status:item.status});
  } catch(error) { console.error('[Submission review]',error); res.status(500).json({error:'REVIEW_FAILED',message:'Could not review this upload. Check the backend log and try again.'}); }
});

app.get('/api/logs', requireAuth, requireGuild, requirePermission('logs:read'), (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const action = String(req.query.action || '').slice(0,80);
  const rows = action
    ? db.prepare('SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY id DESC LIMIT ?').all(`%${action}%`, limit)
    : db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ logs: rows.map(row => ({ ...row, details: JSON.parse(row.details || '{}') })) });
});

app.post('/api/announcements/send', requireAuth, requireGuild, requirePermission('announcements:send'), async (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error:'BOT_OFFLINE' });
  const body = req.body || {};
  const channelId = String(body.channelId || botSettings().announcementChannelId || '').trim();
  if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error:'ANNOUNCEMENT_CHANNEL_REQUIRED' });
  const title = String(body.title || '').trim().slice(0,256);
  const description = String(body.description || '').trim().slice(0,4000);
  if (!title && !description) return res.status(400).json({ error:'MESSAGE_CONTENT_REQUIRED' });
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return res.status(400).json({ error:'CHANNEL_NOT_TEXT' });
    const embed = new EmbedBuilder().setColor(/^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#ED2434');
    if (body.authorName) embed.setAuthor({ name:String(body.authorName).slice(0,256), ...(body.authorIcon && /^https:\/\//i.test(body.authorIcon) ? { iconURL:body.authorIcon } : {}) });
    if (title) embed.setTitle(title);
    if (body.url && /^https:\/\//i.test(body.url)) embed.setURL(body.url);
    if (description) embed.setDescription(description);
    if (body.timestamp) embed.setTimestamp();
    const files = [];
    const resolveEmbedImage = value => {
      const raw = String(value || '');
      // Locally uploaded files are attached to the Discord message, so Discord can render them without accessing localhost.
      const match = raw.match(/\/uploads\/([a-zA-Z0-9._-]+)$/);
      if (match) {
        const filename = path.basename(match[1]);
        const fullPath = path.join(UPLOAD_DIR, filename);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const attachmentName = `anarchy-${filename}`;
          files.push({ attachment: fullPath, name: attachmentName });
          return `attachment://${attachmentName}`;
        }
      }
      return /^https:\/\//i.test(raw) ? raw : '';
    };
    const thumbnailUrl = resolveEmbedImage(body.thumbnail);
    const imageUrl = resolveEmbedImage(body.image);
    if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
    if (imageUrl) embed.setImage(imageUrl);
    if (body.footer) embed.setFooter({ text: String(body.footer).slice(0,2048) });
    if (Array.isArray(body.fields)) embed.addFields(body.fields.slice(0,25).filter(f => f?.name && f?.value).map(f => ({ name:String(f.name).slice(0,256), value:String(f.value).slice(0,1024), inline:Boolean(f.inline) })));
    const sent = await channel.send({ embeds:[embed], ...(files.length ? { files } : {}) });
    insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'announcement.sent', targetType:'discord_message', targetId:sent.id, details:{ channelId, title }, req });
    res.json({ success:true, messageId:sent.id, channelId });
  } catch (error) {
    insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'announcement.send_failed', targetType:'channel', targetId:channelId, result:'failed', details:{ error:error.message }, req });
    res.status(400).json({ error:'ANNOUNCEMENT_SEND_FAILED', message:error.message });
  }
});

// Simple ticket API: the user can open and reply to their own ticket; ticket managers can claim/close.
app.post('/api/tickets', requireAuth, requireGuild, (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0,120);
  const message = String(req.body?.message || '').trim().slice(0,4000);
  const category = String(req.body?.category || 'General').trim().slice(0,40);
  if (!subject || !message) return res.status(400).json({ error:'SUBJECT_AND_MESSAGE_REQUIRED' });
  const time = nowIso();
  const info = db.prepare('INSERT INTO tickets(owner_id,subject,category,status,created_at,updated_at) VALUES(?,?,?,\'open\',?,?)').run(req.session.user.id, subject, category, time, time);
  const ticketId = Number(info.lastInsertRowid);
  const number = `AN-${String(ticketId).padStart(5,'0')}`;
  db.prepare('UPDATE tickets SET ticket_number=? WHERE id=?').run(number, ticketId);
  db.prepare('INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?)').run(ticketId, req.session.user.id, req.session.user.username, message, time);
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'ticket.opened', targetType:'ticket', targetId:number, details:{ subject, category, initialMessage:message }, req });
  res.status(201).json({ success:true, ticketNumber:number });
});
app.get('/api/tickets', requireAuth, requireGuild, (req, res) => {
  const canManage = hasPermission(req, 'tickets:manage') || hasPermission(req, 'admin:all');
  const tickets = canManage
    ? db.prepare('SELECT * FROM tickets ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'claimed\' THEN 1 ELSE 2 END, id DESC').all()
    : db.prepare('SELECT * FROM tickets WHERE owner_id=? ORDER BY id DESC').all(req.session.user.id);
  res.json({ tickets });
});
app.get('/api/tickets/:id/messages', requireAuth, requireGuild, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error:'TICKET_NOT_FOUND' });
  if (ticket.owner_id !== req.session.user.id && !hasPermission(req, 'tickets:manage') && !hasPermission(req, 'admin:all')) return res.status(403).json({ error:'FORBIDDEN' });
  res.json({ ticket, messages: db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(ticket.id) });
});
app.post('/api/tickets/:id/messages', requireAuth, requireGuild, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error:'TICKET_NOT_FOUND' });
  const manager = hasPermission(req, 'tickets:manage') || hasPermission(req, 'admin:all');
  if (ticket.owner_id !== req.session.user.id && !manager) return res.status(403).json({ error:'FORBIDDEN' });
  if (ticket.status === 'closed') return res.status(409).json({ error:'TICKET_CLOSED' });
  const message = String(req.body?.message || '').trim().slice(0,4000);
  if (!message) return res.status(400).json({ error:'MESSAGE_REQUIRED' });
  const time = nowIso();
  db.prepare('INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?)').run(ticket.id, req.session.user.id, req.session.user.username, message, time);
  db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(time, ticket.id);
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:'ticket.reply', targetType:'ticket', targetId:ticket.ticket_number, details:{ message }, req });
  res.json({ success:true });
});
app.patch('/api/tickets/:id', requireAuth, requireGuild, requirePermission('tickets:manage'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error:'TICKET_NOT_FOUND' });
  const action = req.body?.action;
  const time = nowIso();
  if (action === 'claim') db.prepare('UPDATE tickets SET status=\'claimed\',claimed_by=?,updated_at=? WHERE id=?').run(req.session.user.id, time, ticket.id);
  else if (action === 'close') db.prepare('UPDATE tickets SET status=\'closed\',closed_at=?,updated_at=? WHERE id=?').run(time, time, ticket.id);
  else if (action === 'reopen') db.prepare('UPDATE tickets SET status=\'open\',closed_at=NULL,claimed_by=NULL,updated_at=? WHERE id=?').run(time, ticket.id);
  else return res.status(400).json({ error:'INVALID_TICKET_ACTION' });
  insertLog({ actorId:req.session.user.id, actorName:req.session.user.username, action:`ticket.${action}`, targetType:'ticket', targetId:ticket.ticket_number, req });
  res.json({ success:true });
});

app.get('/api/leaderboard', requireAuth, requireGuild, requirePermission('leaderboard:read'), (req, res) => {
  const period = ['alltime','week','month'].includes(req.query.period) ? req.query.period : 'alltime';
  const members = db.prepare('SELECT user_id,username,global_name,avatar FROM discord_members WHERE in_guild=1').all();
  const rows = members.map(member => ({ ...member, minutes: shiftTotals(member.user_id, period) })).sort((a,b) => b.minutes - a.minutes);
  res.json({ period, leaderboard: rows });
});

app.use((err, req, res, _next) => {
  console.error('[HTTP error]', err.message);
  if (err instanceof multer.MulterError) return res.status(400).json({ error:'UPLOAD_FAILED', message:err.message });
  if (res.headersSent) return;
  res.status(500).json({ error:'INTERNAL_ERROR', message:process.env.NODE_ENV === 'production' ? 'Unexpected server error.' : err.message });
});

async function startDiscordBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.warn('[Discord] DISCORD_TOKEN missing; website API will start, bot stays offline.');
    return;
  }
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences], partials: [Partials.GuildMember, Partials.User] });
  client.once(Events.ClientReady, async readyClient => {
    botReady = true;
    console.log(`[Discord] ${readyClient.user.tag} is ready.`);
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) { botLastError = 'Configured guild is not accessible to the bot.'; console.error('[Discord]', botLastError); }
      else await syncGuildMembers();
    }
    await refreshClockPanel();
    await refreshLeaderboardPanel();
  });
  client.on(Events.GuildMemberAdd, member => syncGuildMember(member).catch(console.error));
  client.on(Events.GuildMemberRemove, member => {
    db.prepare('UPDATE discord_members SET in_guild=0,synced_at=? WHERE user_id=?').run(nowIso(), member.id);
    insertLog({ actorId:null, actorName:'Discord system', action:'discord.member.left', targetType:'member', targetId:member.id, details:{ guildId:member.guild.id } });
  });
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      await syncGuildMember(newMember);
      const before = new Set([...oldMember.roles.cache.keys()].filter(id => id !== newMember.guild.id));
      const after = new Set([...newMember.roles.cache.keys()].filter(id => id !== newMember.guild.id));
      for (const roleId of after) if (!before.has(roleId)) insertLog({ actorId:null, actorName:'Discord system', action:'discord.role.added', targetType:'member', targetId:newMember.id, details:{ roleId, source:'Discord role update' } });
      for (const roleId of before) if (!after.has(roleId)) insertLog({ actorId:null, actorName:'Discord system', action:'discord.role.removed', targetType:'member', targetId:newMember.id, details:{ roleId, source:'Discord role update' } });
    } catch (error) { console.error('[Discord member update]', error.message); }
  });
  client.on(Events.PresenceUpdate, async (_oldPresence, newPresence) => {
    if (!newPresence?.userId) return;
    const active = db.prepare('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL').get(newPresence.userId);
    if (!active || hasActivity(newPresence.member)) return;
    // Presence updates can be partial; only clock out when Discord has supplied a member presence.
    if (!newPresence.member?.presence) return;
    await closeShift(newPresence.userId, 'activity-ended');
  });
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (['an_lb_alltime','an_lb_week','an_lb_month'].includes(interaction.customId)) {
      await interaction.deferUpdate();
      const period = interaction.customId === 'an_lb_week' ? 'week' : interaction.customId === 'an_lb_month' ? 'month' : 'alltime';
      await refreshLeaderboardPanel(period);
      return;
    }
    if (interaction.customId.startsWith('an_submission_')) {
      const match=interaction.customId.match(/^an_submission_(approve|reject):([a-f0-9-]+)$/i); if(!match)return;
      const guildMember=interaction.member; const mapping=roleMappings(); const roleIds=[mapping.owner,mapping.boss,mapping.coboss].filter(Boolean);
      if(!guildMember?.roles?.cache || !roleIds.some(id=>guildMember.roles.cache.has(id))) return interaction.reply({content:'You are not authorized to review ANARCHY uploads.',ephemeral:true});
      const action=match[1], id=match[2]; const row=db.prepare("SELECT collection,data FROM records WHERE id=? AND collection IN ('clipRequests','galleryRequests')").get(id);
      if(!row)return interaction.reply({content:'This request no longer exists.',ephemeral:true}); const item=JSON.parse(row.data); if(item.status!=='pending')return interaction.reply({content:`This request was already ${item.status}.`,ephemeral:true});
      item.status=action==='approve'?'approved':'rejected'; item.reviewedBy=interaction.user.id; item.reviewedAt=nowIso();
      try {
        const reviewedAt=nowIso();
        const tx=db.transaction(()=>{
          if(action==='approve'){
            const collection=row.collection==='clipRequests'?'clips':'gallery'; const publishedId=crypto.randomUUID();
            const published={...item,id:publishedId,title:item.originalName,name:item.originalName,image:item.type==='gallery'?item.url:'',url:item.url,video:item.type==='clip'?item.url:'',status:'published',sourceRequestId:id};
            db.prepare('INSERT INTO records(id,collection,data,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(publishedId,collection,JSON.stringify(published),item.submitterId,item.createdAt,reviewedAt);
          }
          db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=? AND collection=?').run(JSON.stringify(item),reviewedAt,id,row.collection);
          insertLog({actorId:interaction.user.id,actorName:interaction.user.username,action:`${item.type}.request.${action}`,targetType:item.type,targetId:id,details:{submitterId:item.submitterId},req:null});
        }); tx();
        await interaction.update({content:`${action==='approve'?'APPROVED':'REJECTED'} by ${interaction.user.tag} · ${item.originalName}`,embeds:interaction.message.embeds,components:[]});
      } catch(error) { console.error('[Discord submission review]',error); if(!interaction.replied && !interaction.deferred) await interaction.reply({content:'Review failed because of a server/database error. Check backend logs.',ephemeral:true}); }
      return;
    }
    if (!['an_clock_in','an_clock_out'].includes(interaction.customId)) return;
    try {
      await interaction.deferReply({ ephemeral:true });
      const member = interaction.member;
      if (interaction.customId === 'an_clock_in') {
        if (!isEligibleForClock(member)) return interaction.editReply('Your Discord roles are not configured for Clock In. Ask an administrator to map the gang role in website Settings.');
        if (!hasActivity(member)) return interaction.editReply('Discord does not currently show the configured FiveM activity. Check your activity privacy settings and try again.');
        const result = await startShift(interaction.user.id, 'discord-button');
        if (result.error) return interaction.editReply('You already have an active shift.');
        await syncGuildMember(member);
        return interaction.editReply('Clock In recorded. Your active shift has started.');
      }
      const result = await closeShift(interaction.user.id, 'discord-button');
      if (!result) return interaction.editReply('You do not have an active shift.');
      return interaction.editReply(`Clock Out recorded: ${Math.floor(result.duration_seconds / 3600)}h ${Math.floor((result.duration_seconds % 3600) / 60)}m.`);
    } catch (error) {
      console.error('[Discord interaction]', error.message);
      if (interaction.deferred) await interaction.editReply('Something went wrong. Please contact an administrator.').catch(() => {});
    }
  });
  client.on('error', error => { botLastError = error.message; console.error('[Discord client]', error); });
  await client.login(process.env.DISCORD_TOKEN);
}

app.use((error, req, res, _next) => {
  console.error('[HTTP error]', error?.stack || error);
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: error.code,
      message: error.code === 'LIMIT_FILE_SIZE' ? 'The uploaded file exceeds the configured size limit.' : 'The uploaded file could not be processed.'
    });
  }
  res.status(500).json({ error:'INTERNAL_SERVER_ERROR', message:'The server could not complete this request.' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`[ANARCHY] API listening on http://localhost:${PORT}`));
startDiscordBot().catch(error => { botLastError = error.message; console.error('[Discord] Startup failed:', error.message); });
const syncTimer = setInterval(() => { if (botReady) syncGuildMembers().catch(console.error); }, 5 * 60 * 1000);
syncTimer.unref();
const panelTimer = setInterval(() => { if (botReady) { refreshClockPanel().catch(() => {}); refreshLeaderboardPanel().catch(() => {}); } }, 60 * 1000);
panelTimer.unref();
async function shutdown(signal) {
  console.log(`[ANARCHY] ${signal}; shutting down...`);
  clearInterval(syncTimer); clearInterval(panelTimer);
  server.close();
  if (client) await client.destroy().catch(() => {});
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
