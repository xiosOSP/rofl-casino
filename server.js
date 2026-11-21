// РофлКазино — демо-казино для игры с друзьями. Деньги ненастоящие.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const START_BALANCE = 10000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ───────────────────────── утилиты ─────────────────────────
const rnd = () => crypto.randomInt(0, 2 ** 47) / 2 ** 47; // [0,1)
const randInt = (n) => crypto.randomInt(0, n);
const r2 = (x) => Math.round(x * 100) / 100;
const rub = (x) => r2(x).toLocaleString('ru-RU') + ' ₽';
const now = () => Date.now();

function pickDistinct(n, k) {
  const arr = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}
function parseBet(x) {
  const v = r2(Number(x));
  if (!Number.isFinite(v) || v < 1) throw new Error('Минимальная ставка — 1 ₽');
  if (v > 1e9) throw new Error('Слишком большая ставка');
  return v;
}
function clampInt(x, lo, hi, def) {
  const v = Math.floor(Number(x));
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}

// Рост множителя у краша и самолётика: m(t) = e^(k·t)
const GROWTH = 0.00009; // 2x ≈ 7.7 c, 10x ≈ 25.6 c
const multAt = (ms) => (ms <= 0 ? 1 : Math.floor(100 * Math.exp(GROWTH * ms)) / 100);
const timeFor = (m) => Math.log(m) / GROWTH;
// edge = 0.97 → 3% преимущество казино; edge = 1 → честно (для дуэлей)
function genCrash(edge) {
  const c = edge / (1 - rnd());
  return Math.min(1000, Math.max(1, Math.floor(c * 100) / 100));
}

// ───────────────────────── хранилище ─────────────────────────
const DATA_VERSION = 2; // смена версии = всё с нуля
let db = { version: DATA_VERSION, users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* первый запуск */ }
if (db.version !== DATA_VERSION || !db.users) {
  console.log('🧹 Новая версия данных — балансы и статистика начинаются с нуля');
  db = { version: DATA_VERSION, users: {} };
}
// секретный код читов: печатается только в консоли сервера (её видит лишь хозяин ПК)
if (!db.cheatCode) db.cheatCode = String(100000 + randInt(900000));
const CHEAT_CODE = String(process.env.CHEAT_CODE || db.cheatCode);
const cheatFails = new Map(); // ник -> неудачные попытки ввести код (5 ошибок = блок на 10 минут)
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 400);
}

// ───────────────────────── игроки ─────────────────────────
// Мама-банк и имущество убраны. Старое имущество продаётся за 70% (+ касса), долги маме списываются.
const OLD_PROP_PRICES = { room: 25000, studio: 80000, center: 200000, penthouse: 1000000, villa: 5000000, shawarma: 50000, wash: 150000, club: 400000, bar: 1200000, casino: 4000000 };
function withDefaults(u) {
  u.balance ??= START_BALANCE; u.wagered ??= 0; u.best ??= 0; u.lives ??= 1; u.bigWin ??= 0;
  u.history ??= []; u.admin ??= false; u.cheats ??= {};
  u.stats ??= {}; u.stats.games ??= {};
  if (Array.isArray(u.props) && u.props.length) {
    u.balance = r2(u.balance + u.props.reduce((t, p) => t + ((OLD_PROP_PRICES[p.type] || 0) + (p.spent || 0)) * 0.7 + (p.cash || 0), 0));
  }
  for (const k of ['props', 'propSeq', 'loans', 'loanSeq', 'trust', 'mom', 'jobCd', 'job', 'grandmaAt', 'refills']) delete u[k];
  for (const k of ['borrowed', 'repaid', 'penalties', 'overdue', 'onTime', 'late', 'jobs', 'jobsEarned', 'grandma', 'confiscated', 'helped', 'propIncome', 'propSpent']) delete u.stats[k];
  delete u.cheats.propBoost;
  return u;
}
for (const u of Object.values(db.users)) withDefaults(u);
db.topWins ??= { amount: [], mult: [] };
save();

const online = new Map(); // name -> кол-во подключений
// чит включён у игрока? (только у админа)
const cheatOn = (name, k) => { const u = db.users[name]; return !!(u && u.admin && u.cheats[k]); };
function cheatInfo(name, data) { io.to('u:' + name).emit('cheatInfo', data); }
const publicUser = (u) => ({
  name: u.name, balance: u.balance, net: u.balance, best: u.best, bigWin: u.bigWin, wagered: u.wagered,
  lives: u.lives, online: (online.get(u.name) || 0) > 0,
});
const privateUser = (u) => ({
  ...publicUser(u), history: u.history, stats: u.stats,
  admin: u.admin, cheats: u.admin ? u.cheats : {}, lastLife: u.lastLife || null, serverNow: now(),
});
function pushUser(name) {
  const u = db.users[name];
  if (u) io.to('u:' + name).emit('me', privateUser(u));
  broadcastPlayers();
}
let playersTimer = null;
function broadcastPlayers() {
  if (playersTimer) return;
  playersTimer = setTimeout(() => {
    playersTimer = null;
    io.emit('players', Object.values(db.users).map(publicUser).sort((a, b) => b.balance - a.balance));
  }, 50);
}

// ───────────────────────── самые большие выигрыши ─────────────────────────
const TOP_N = 15;
function recordWin(name, game, stake, payout) {
  if (!(stake > 0) || !(payout > stake)) return;
  const w = { name, game, stake, payout, profit: r2(payout - stake), mult: Math.floor((payout / stake) * 100) / 100, t: now() };
  let changed = false;
  for (const [list, key] of [[db.topWins.amount, 'profit'], [db.topWins.mult, 'mult']]) {
    if (list.length < TOP_N || w[key] > list[list.length - 1][key]) {
      list.push(w); list.sort((a, b) => b[key] - a[key] || a.t - b.t); list.length = Math.min(list.length, TOP_N);
      changed = true;
    }
  }
  const u = db.users[name];
  if (u && w.profit > u.bigWin) u.bigWin = w.profit;
  if (changed) io.emit('topWins', db.topWins);
}

// ───────────────────────── деньги: ставки и выплаты ─────────────────────────
const gameStats = (u, game) => (u.stats.games[game] ??= { played: 0, won: 0, wagered: 0, returned: 0 });
function placeBet(name, amount, game, count = true) {
  const u = db.users[name];
  if (!(amount > 0) || amount > u.balance + 1e-9) throw new Error('Недостаточно средств');
  u.balance = r2(u.balance - amount);
  u.wagered = r2(u.wagered + amount);
  const g = gameStats(u, game);
  g.wagered = r2(g.wagered + amount);
  if (count) g.played++;
  save(); pushUser(name);
}
function refund(name, amount, game) {
  const u = db.users[name];
  u.balance = r2(u.balance + amount);
  u.wagered = r2(u.wagered - amount);
  const g = gameStats(u, game);
  g.wagered = r2(g.wagered - amount);
  g.played = Math.max(0, g.played - 1);
  save(); pushUser(name);
}
// выплата по завершённой ставке (payout = 0 — проигрыш)
function settle(name, game, stake, payout, mult) {
  const u = db.users[name];
  if (!u) return { kept: 0, taken: 0 };
  payout = r2(payout || 0);
  const g = gameStats(u, game);
  g.returned = r2(g.returned + payout);
  if (payout > stake) g.won++;
  u.balance = r2(u.balance + payout);
  if (mult && mult > 1 && mult > u.best) u.best = r2(mult);
  u.history.unshift({ t: now(), game, stake, payout });
  u.history.length = Math.min(u.history.length, 40);
  recordWin(name, game, stake, payout);
  save(); pushUser(name);
  return { kept: payout, taken: 0 };
}

// лента событий и чат
const feed = [];
function addFeed(text, kind = 'info') {
  const item = { t: now(), text, kind };
  feed.unshift(item); feed.length = Math.min(feed.length, 40);
  io.emit('feed', item);
}
const chat = [];

// ───────────────────────── кейсы ─────────────────────────
const CASES = [
  { id: 'school', name: 'Школьник', emoji: '🏫', price: 50, items: [
    { name: 'Жвачка', emoji: '🍬', value: 5, w: 300 },
    { name: 'Сменка', emoji: '🩴', value: 15, w: 260 },
    { name: 'Списанная домашка', emoji: '📓', value: 40, w: 200 },
    { name: 'Пятёрка в дневнике', emoji: '5️⃣', value: 60, w: 120 },
    { name: 'Карманные', emoji: '💵', value: 120, w: 60 },
    { name: 'Самокат', emoji: '🛴', value: 400, w: 15 },
    { name: 'Айфон одноклассника', emoji: '📱', value: 2500, w: 2 },
  ] },
  { id: 'bomzh', name: 'Бомж-кейс', emoji: '🗑️', price: 100, items: [
    { name: 'Семечки', emoji: '🌻', value: 10, w: 300 },
    { name: 'Доширак', emoji: '🍜', value: 30, w: 260 },
    { name: 'Шаурма', emoji: '🌯', value: 70, w: 200 },
    { name: 'Пиво', emoji: '🍺', value: 110, w: 120 },
    { name: 'Пицца', emoji: '🍕', value: 180, w: 70 },
    { name: 'Кроссы с рынка', emoji: '👟', value: 450, w: 30 },
    { name: 'Самокат', emoji: '🛴', value: 1200, w: 12 },
    { name: 'Айфон', emoji: '📱', value: 6000, w: 3 },
  ] },
  { id: 'mama', name: 'Мамин кейс', emoji: '👩', price: 200, items: [
    { name: 'Тапок (прилетел)', emoji: '🩴', value: 10, w: 300 },
    { name: 'Шерстяные носки', emoji: '🧦', value: 60, w: 250 },
    { name: 'Тарелка борща', emoji: '🍲', value: 150, w: 200 },
    { name: 'Котлеты с собой', emoji: '🍱', value: 250, w: 120 },
    { name: 'Шапка (надень!)', emoji: '🧢', value: 500, w: 50 },
    { name: 'Конверт «на чёрный день»', emoji: '✉️', value: 2000, w: 12 },
    { name: 'Мамина заначка', emoji: '💰', value: 10000, w: 2 },
  ] },
  { id: 'dacha', name: 'Дача', emoji: '🏡', price: 300, items: [
    { name: 'Огурцы', emoji: '🥒', value: 20, w: 300 },
    { name: 'Рассада', emoji: '🌱', value: 80, w: 250 },
    { name: 'Шашлык', emoji: '🍢', value: 250, w: 200 },
    { name: 'Мангал', emoji: '🔥', value: 450, w: 120 },
    { name: 'Баня', emoji: '🧖', value: 1200, w: 40 },
    { name: 'Мотоблок', emoji: '🚜', value: 4000, w: 10 },
    { name: 'Участок у озера', emoji: '🏞️', value: 20000, w: 1 },
  ] },
  { id: 'student', name: 'Студент', emoji: '🎒', price: 500, items: [
    { name: 'Проездной', emoji: '🚌', value: 80, w: 300 },
    { name: 'Энергетик ящик', emoji: '⚡', value: 200, w: 250 },
    { name: 'Стипендия', emoji: '💵', value: 450, w: 200 },
    { name: 'Наушники', emoji: '🎧', value: 900, w: 120 },
    { name: 'Видеокарта б/у', emoji: '🖥️', value: 2000, w: 45 },
    { name: 'Ноутбук', emoji: '💻', value: 5000, w: 10 },
    { name: 'Автомат по сессии', emoji: '🎓', value: 15000, w: 2 },
  ] },
  { id: 'otaku', name: 'Отаку', emoji: '🍥', price: 750, items: [
    { name: 'Значок с вайфу', emoji: '📛', value: 50, w: 300 },
    { name: 'Брелок', emoji: '🔑', value: 200, w: 250 },
    { name: 'Том манги', emoji: '📚', value: 600, w: 200 },
    { name: 'Фигурка', emoji: '🗿', value: 1500, w: 110 },
    { name: 'Косплей-костюм', emoji: '👘', value: 4000, w: 35 },
    { name: 'Дакимакура', emoji: '🛏️', value: 9000, w: 8 },
    { name: 'Поездка в Японию', emoji: '🗾', value: 60000, w: 1 },
  ] },
  { id: 'gamer', name: 'Геймер', emoji: '🎮', price: 1000, items: [
    { name: 'Донат 99 ₽', emoji: '🪙', value: 99, w: 300 },
    { name: 'Коврик', emoji: '🟫', value: 400, w: 250 },
    { name: 'Скин на нож', emoji: '🔪', value: 900, w: 200 },
    { name: 'Механическая клава', emoji: '⌨️', value: 2000, w: 110 },
    { name: 'PS5', emoji: '🎮', value: 6000, w: 30 },
    { name: 'Игровой ПК', emoji: '🖥️', value: 20000, w: 6 },
    { name: 'Контракт с киберспорт-командой', emoji: '🏆', value: 80000, w: 1 },
  ] },
  { id: 'allin', name: 'Всё или ничего', emoji: '🎲', price: 1000, items: [
    { name: 'Пустота', emoji: '🕳️', value: 0, w: 900 },
    { name: 'Утешительный приз', emoji: '🍭', value: 500, w: 200 },
    { name: 'Удвоение', emoji: '✌️', value: 2000, w: 100 },
    { name: 'Джекпот ×10', emoji: '💥', value: 10000, w: 25 },
    { name: 'Мега-джекпот ×50', emoji: '🌈', value: 50000, w: 4 },
  ] },
  { id: 'club', name: 'Ночной клуб', emoji: '🌃', price: 1500, items: [
    { name: 'Штамп на руке', emoji: '🖐️', value: 100, w: 300 },
    { name: 'Коктейль', emoji: '🍹', value: 600, w: 250 },
    { name: 'Кальян на компанию', emoji: '💨', value: 1500, w: 200 },
    { name: 'VIP-стол', emoji: '🛋️', value: 4000, w: 90 },
    { name: 'Бутылка шампанского', emoji: '🍾', value: 9000, w: 25 },
    { name: 'Ламбо до утра', emoji: '🏎️', value: 40000, w: 3 },
  ] },
  { id: 'major', name: 'Мажор', emoji: '💎', price: 2500, items: [
    { name: 'Кальян', emoji: '💨', value: 400, w: 300 },
    { name: 'Кроссовки Jordan', emoji: '👟', value: 1200, w: 250 },
    { name: 'Пятёрка', emoji: '💸', value: 2500, w: 200 },
    { name: 'PlayStation', emoji: '🎮', value: 5000, w: 120 },
    { name: 'Часы', emoji: '⌚', value: 12000, w: 30 },
    { name: 'Байк', emoji: '🏍️', value: 30000, w: 7 },
    { name: 'Гелик', emoji: '🚙', value: 100000, w: 1 },
  ] },
  { id: 'crypto', name: 'Крипта', emoji: '₿', price: 5000, items: [
    { name: 'Скам-токен', emoji: '🐸', value: 50, w: 400 },
    { name: 'Мем-коин', emoji: '🐕', value: 1500, w: 250 },
    { name: 'Эфир', emoji: '💠', value: 5000, w: 180 },
    { name: 'NFT с обезьяной', emoji: '🐒', value: 12000, w: 70 },
    { name: 'Ферма в гараже', emoji: '⛏️', value: 40000, w: 12 },
    { name: 'Биткоин', emoji: '₿', value: 250000, w: 1 },
  ] },
  { id: 'oligarch', name: 'Олигарх', emoji: '👑', price: 10000, items: [
    { name: 'Ужин в ресторане', emoji: '🍾', value: 2000, w: 450 },
    { name: 'Шуба', emoji: '🧥', value: 5000, w: 250 },
    { name: 'Котлета налички', emoji: '💰', value: 10000, w: 200 },
    { name: 'Ролекс', emoji: '⌚', value: 25000, w: 90 },
    { name: 'Порш', emoji: '🏎️', value: 60000, w: 30 },
    { name: 'Яхта', emoji: '🛥️', value: 200000, w: 5 },
    { name: 'Остров', emoji: '🏝️', value: 500000, w: 1 },
  ] },
  { id: 'space', name: 'Космос', emoji: '🚀', price: 25000, items: [
    { name: 'Космическая еда в тюбике', emoji: '🧃', value: 2000, w: 400 },
    { name: 'Метеорит', emoji: '☄️', value: 10000, w: 250 },
    { name: 'Скафандр', emoji: '👨‍🚀', value: 25000, w: 180 },
    { name: 'Спутник', emoji: '🛰️', value: 60000, w: 80 },
    { name: 'Полёт на МКС', emoji: '🚀', value: 200000, w: 10 },
    { name: 'Участок на Луне', emoji: '🌕', value: 2500000, w: 1 },
  ] },
];
const CASE_RTP = 0.97;
for (const c of CASES) {
  // подбираем вес самого дешёвого предмета так, чтобы возврат кейса был ≈ CASE_RTP
  const low = c.items.reduce((m, i) => (i.value < m.value ? i : m), c.items[0]);
  const rest = c.items.filter((i) => i !== low);
  const S = rest.reduce((s, i) => s + i.value * i.w, 0), Wr = rest.reduce((s, i) => s + i.w, 0);
  const T = c.price * CASE_RTP;
  const w0 = (S - T * Wr) / (T - low.value);
  if (w0 > 0 && T > low.value) low.w = Math.round(w0 * 100) / 100;
  const W = c.items.reduce((s, i) => s + i.w, 0);
  c.ev = r2(c.items.reduce((s, i) => s + i.value * i.w, 0) / W);
  for (const it of c.items) {
    it.chance = Math.round((it.w / W) * 10000) / 100;
    const k = it.value / c.price;
    it.rarity = k < 0.5 ? 'common' : k < 1.2 ? 'rare' : k < 4 ? 'epic' : k < 20 ? 'legend' : 'gold';
  }
}
const caseById = (id) => CASES.find((c) => c.id === id);
const casePending = new Map(); // name -> сколько кейсов ещё крутится
const topItem = (c) => c.items.reduce((m, i) => (i.value > m.value ? i : m), c.items[0]);
const rollCaseFor = (name, c) => (cheatOn(name, 'topDrop') ? topItem(c) : rollCase(c));
function rollCase(c) {
  const W = c.items.reduce((s, i) => s + i.w, 0);
  let x = rnd() * W;
  for (const it of c.items) { if ((x -= it.w) < 0) return it; }
  return c.items[0];
}
const itemView = (it) => ({ name: it.name, emoji: it.emoji, value: it.value, rarity: it.rarity });
const CASE_SPIN_MS = 5200;

// ───────────────────────── мины (соло) ─────────────────────────
const MINES_CELLS = 25;
function minesMult(mines, n) {
  if (n <= 0) return 1;
  let m = 0.97;
  for (let i = 0; i < n; i++) m *= (MINES_CELLS - i) / (MINES_CELLS - mines - i);
  return Math.floor(m * 100) / 100;
}
const minesSolo = {}; // name -> {bet, mines, field:Set, opened:[]}
function minesSoloView(name) {
  const s = minesSolo[name];
  if (!s) return null;
  return {
    bet: s.bet, mines: s.mines, opened: s.opened, xray: cheatOn(name, 'xray') ? [...s.field] : null,
    mult: minesMult(s.mines, s.opened.length),
    next: minesMult(s.mines, s.opened.length + 1),
  };
}

// ───────────────────────── башни ─────────────────────────
const TOWER_ROWS = 8;
const TOWER_DIFF = {
  easy: { cols: 4, bombs: 1, label: 'Лёгкая' },
  medium: { cols: 3, bombs: 1, label: 'Средняя' },
  hard: { cols: 2, bombs: 1, label: 'Сложная' },
  extreme: { cols: 3, bombs: 2, label: 'Экстрим' },
};
function towerMult(diff, level) {
  if (level <= 0) return 1;
  const d = TOWER_DIFF[diff];
  return Math.floor(0.97 * Math.pow(d.cols / (d.cols - d.bombs), level) * 100) / 100;
}
const genTower = (diff) => {
  const d = TOWER_DIFF[diff];
  return Array.from({ length: TOWER_ROWS }, () => pickDistinct(d.cols, d.bombs));
};
const towersSolo = {}; // name -> {bet, diff, layout, picks:[]}
function towersSoloView(name) {
  const s = towersSolo[name];
  if (!s) return null;
  return {
    bet: s.bet, diff: s.diff, picks: s.picks, level: s.picks.length, xray: cheatOn(name, 'xray') ? s.layout : null,
    mult: towerMult(s.diff, s.picks.length), next: towerMult(s.diff, s.picks.length + 1),
  };
}

// ───────────────────────── футбол (серия пенальти) ─────────────────────────
const FB_ZONES = 6, FB_KICKS = 5;
const FB_DIFF = {
  easy: { keeper: 1, label: 'Новичок' }, medium: { keeper: 2, label: 'Профи' },
  hard: { keeper: 3, label: 'Легенда' }, insane: { keeper: 4, label: 'Стена' },
};
const fbP = (diff) => (FB_ZONES - FB_DIFF[diff].keeper) / FB_ZONES; // шанс гола
const fbMult = (diff, n) => (n <= 0 ? 1 : Math.floor((0.97 / Math.pow(fbP(diff), n)) * 100) / 100);
const football = {}; // name -> {bet, diff, kicks:[{zone, covered}], next:[зоны вратаря на следующий удар]}
function fbView(name) {
  const s = football[name];
  if (!s) return null;
  const n = s.kicks.length;
  return { bet: s.bet, diff: s.diff, kicks: s.kicks, goals: n, mult: fbMult(s.diff, n), next: fbMult(s.diff, n + 1), xray: cheatOn(name, 'xray') ? s.next : null };
}

// ───────────────────────── самолётик (общий раунд) ─────────────────────────
const PLANE_BET_MS = 8000;
const PLANE_AFTER_MS = 4000;
const plane = { phase: 'betting', round: 0, betEndsAt: 0, flyStart: 0, crash: 1, bets: {}, history: [] };
let planeTick = null;
function planeView() {
  return {
    phase: plane.phase, round: plane.round, betEndsAt: plane.betEndsAt, flyStart: plane.flyStart,
    crash: plane.phase === 'crashed' ? plane.crash : null,
    bets: Object.entries(plane.bets).map(([name, b]) => ({ name, amount: b.amount, auto: b.auto, cashedAt: b.cashedAt, win: b.win })),
    history: plane.history, serverNow: now(),
  };
}
const emitPlane = () => io.emit('plane', planeView());
function planeCashout(name, m) {
  const b = plane.bets[name];
  b.cashedAt = m; b.win = r2(b.amount * m);
  settle(name, 'plane', b.amount, b.win, m);
  if (m >= 10) addFeed(`✈️ ${name}: ×${m.toFixed(2)} в самолётике → +${rub(b.win)}`, 'win');
}
function planeBetting() {
  plane.phase = 'betting'; plane.round++; plane.bets = {};
  plane.betEndsAt = now() + PLANE_BET_MS;
  emitPlane();
  setTimeout(planeFly, PLANE_BET_MS);
}
function planeFly() {
  plane.phase = 'flying'; plane.crash = genCrash(0.97); plane.flyStart = now();
  const crashAt = plane.flyStart + timeFor(plane.crash);
  emitPlane();
  for (const name of online.keys()) if (online.get(name) && cheatOn(name, 'crashSight')) cheatInfo(name, { plane: { round: plane.round, crash: plane.crash } });
  planeTick = setInterval(() => {
    const t = now();
    let changed = false;
    for (const [name, b] of Object.entries(plane.bets)) {
      if (b.cashedAt || !b.auto || b.auto > plane.crash) continue;
      if (t >= plane.flyStart + timeFor(b.auto)) { planeCashout(name, b.auto); changed = true; }
    }
    if (t >= crashAt) { clearInterval(planeTick); planeCrash(); return; }
    if (changed) emitPlane();
  }, 50);
}
function planeCrash() {
  plane.phase = 'crashed';
  for (const [name, b] of Object.entries(plane.bets)) if (!b.cashedAt) settle(name, 'plane', b.amount, 0);
  plane.history.unshift(plane.crash); plane.history.length = Math.min(plane.history.length, 25);
  emitPlane();
  setTimeout(planeBetting, PLANE_AFTER_MS);
}

// ───────────────────────── рулетка (общий стол) ─────────────────────────
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
const ROUL_BET_MS = 15000, ROUL_SPIN_MS = 7000, ROUL_RESULT_MS = 4000;
const roul = { phase: 'betting', endsAt: 0, bets: [], result: null, history: [], wins: {}, round: 0 };
const ROUL_TYPES = {
  num: { mult: 36, test: (n, v) => n === v },
  red: { mult: 2, test: (n) => colorOf(n) === 'red' },
  black: { mult: 2, test: (n) => colorOf(n) === 'black' },
  even: { mult: 2, test: (n) => n !== 0 && n % 2 === 0 },
  odd: { mult: 2, test: (n) => n % 2 === 1 },
  low: { mult: 2, test: (n) => n >= 1 && n <= 18 },
  high: { mult: 2, test: (n) => n >= 19 },
  dozen: { mult: 3, test: (n, v) => n !== 0 && Math.ceil(n / 12) === v },
  column: { mult: 3, test: (n, v) => n !== 0 && ((n - 1) % 3) + 1 === v },
};
function roulView() {
  return {
    phase: roul.phase, endsAt: roul.endsAt, round: roul.round,
    result: roul.phase === 'betting' ? null : roul.result,
    bets: roul.bets.map((b) => ({ name: b.name, type: b.type, value: b.value, amount: b.amount })),
    wins: roul.phase === 'result' ? roul.wins : {},
    history: roul.history, serverNow: now(),
  };
}
const emitRoul = () => io.emit('roulette', roulView());
function roulBetting() {
  roul.phase = 'betting'; roul.round++; roul.bets = []; roul.wins = {}; roul.result = null;
  roul.endsAt = now() + ROUL_BET_MS;
  emitRoul();
  setTimeout(roulSpin, ROUL_BET_MS);
}
function roulSpin() {
  roul.phase = 'spinning'; roul.result = randInt(37); roul.endsAt = now() + ROUL_SPIN_MS;
  for (const u of Object.values(db.users)) {
    if (u.admin && Number.isInteger(u.cheats.rouletteNext)) {
      roul.result = u.cheats.rouletteNext; u.cheats.rouletteNext = null; save(); pushUser(u.name); break;
    }
  }
  emitRoul();
  setTimeout(roulSettle, ROUL_SPIN_MS);
}
function roulSettle() {
  const n = roul.result;
  const wins = {};
  for (const b of roul.bets) {
    const T = ROUL_TYPES[b.type];
    if (T.test(n, b.value)) wins[b.name] = r2((wins[b.name] || 0) + b.amount * T.mult);
  }
  const stakes = {};
  for (const b of roul.bets) stakes[b.name] = r2((stakes[b.name] || 0) + b.amount);
  for (const [name, st] of Object.entries(stakes)) settle(name, 'roulette', st, wins[name] || 0);
  for (const [name, w] of Object.entries(wins)) {
    if (w >= 5000) addFeed(`🎡 ${name}: +${rub(w)} в рулетке (выпало ${n})`, 'win');
  }
  roul.wins = wins; roul.phase = 'result'; roul.endsAt = now() + ROUL_RESULT_MS;
  roul.history.unshift(n); roul.history.length = Math.min(roul.history.length, 30);
  emitRoul();
  setTimeout(roulBetting, ROUL_RESULT_MS);
}

// ───────────────────────── дуэли 1 на 1 ─────────────────────────
const GAME_NAMES = { mines: 'мины-дуэль', towers: 'башни-дуэль', cases: 'кейс-батл', coin: 'монетка' };
const DUEL_KEY = { mines: 'mines-duel', towers: 'towers-duel', cases: 'cases-battle', coin: 'coin' };
const COIN_MS = 3200;
const duels = new Map();
let duelSeq = 1;
const activeDuelOf = (name) => [...duels.values()].find((d) => d.status !== 'done' && d.players.includes(name));

function duelView(d, viewer) {
  const done = d.status === 'done';
  const base = {
    id: d.id, game: d.game, stake: d.stake, config: d.config, creator: d.creator,
    players: d.players, status: d.status, createdAt: d.createdAt, result: d.result,
  };
  const s = d.state;
  if (!s) return base;
  if (d.game === 'mines') {
    const p = {};
    for (const [n, ps] of Object.entries(s.p)) p[n] = { count: ps.opened.length, status: ps.status, opened: n === viewer || done ? ps.opened : null, hit: ps.hit };
    base.state = { p, field: done ? s.field : null, xray: !done && cheatOn(viewer, 'xray') ? s.field : null };
  } else if (d.game === 'towers') {
    const p = {};
    for (const [n, ps] of Object.entries(s.p)) p[n] = { level: ps.picks.length, status: ps.status, picks: n === viewer || done ? ps.picks : null, hit: ps.hit };
    base.state = { p, layout: done ? s.layout : null, xray: !done && cheatOn(viewer, 'xray') ? s.layout : null };
  } else if (d.game === 'cases') {
    base.state = { rolls: s.rolls, startAt: s.startAt };
  } else if (d.game === 'coin') {
    base.state = { flip: s.flip, startAt: s.startAt };
  }
  return base;
}
function broadcastDuels() {
  const list = [...duels.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const name of online.keys()) {
    if (!online.get(name)) continue;
    io.to('u:' + name).emit('duels', { list: list.map((d) => duelView(d, name)), serverNow: now() });
  }
}
function cleanupDuels() {
  const done = [...duels.values()].filter((d) => d.status === 'done').sort((a, b) => b.createdAt - a.createdAt);
  for (const d of done.slice(12)) duels.delete(d.id);
}

function settleDuel(d, scores) {
  if (d.status === 'done') return;
  clearTimeout(d.timer);
  d.status = 'done';
  const [a, b] = d.players;
  const pot = d.game === 'cases' ? null : d.stake * 2;
  let winner = null;
  const crazy = d.game === 'cases' && d.config.mode === 'crazy'; // в безумном батле выигрывает меньший дроп
  if (scores[a] !== scores[b]) winner = (scores[a] > scores[b]) !== crazy ? a : b;
  const game = GAME_NAMES[d.game], key = DUEL_KEY[d.game];
  const loser = winner === a ? b : a;
  if (d.game === 'cases') {
    const ta = scores[a], tb = scores[b];
    if (winner) {
      settle(winner, key, d.stake, r2(ta + tb));
      settle(loser, key, d.stake, 0);
      addFeed(`🏆 ${winner} побеждает ${winner === a ? b : a} (${game}) → +${rub(ta + tb)}`, 'duel');
    } else {
      settle(a, key, d.stake, ta); settle(b, key, d.stake, tb);
      addFeed(`🤝 Ничья в кейс-батле ${a} vs ${b}`, 'duel');
    }
    d.result = { winner, scores, prize: winner ? r2(ta + tb) : null };
  } else {
    if (winner) {
      settle(winner, key, d.stake, pot);
      settle(loser, key, d.stake, 0);
      addFeed(`🏆 ${winner} побеждает ${winner === a ? b : a} (${game}) → +${rub(pot)}`, 'duel');
    } else {
      settle(a, key, d.stake, d.stake); settle(b, key, d.stake, d.stake);
      addFeed(`🤝 Ничья: ${a} vs ${b} (${game}) — ставки вернулись`, 'duel');
    }
    d.result = { winner, scores, prize: winner ? pot : null };
  }
  cleanupDuels();
  broadcastDuels();
}

function startDuel(d) {
  d.status = 'playing';
  const [a, b] = d.players;
  if (d.game === 'mines') {
    const fresh = () => ({ opened: [], status: 'playing', hit: null });
    d.state = { field: pickDistinct(MINES_CELLS, d.config.mines), p: { [a]: fresh(), [b]: fresh() } };
  } else if (d.game === 'towers') {
    const fresh = () => ({ picks: [], status: 'playing', hit: null });
    d.state = { layout: genTower(d.config.diff), p: { [a]: fresh(), [b]: fresh() } };
  } else if (d.game === 'cases') {
    const c = caseById(d.config.caseId);
    const rolls = { [a]: [], [b]: [] };
    for (let i = 0; i < d.config.count; i++) { rolls[a].push(itemView(rollCaseFor(a, c))); rolls[b].push(itemView(rollCaseFor(b, c))); }
    d.state = { rolls, startAt: now() + 1500 };
    const sum = (arr) => r2(arr.reduce((s, it) => s + it.value, 0));
    d.timer = setTimeout(() => settleDuel(d, { [a]: sum(rolls[a]), [b]: sum(rolls[b]) }),
      1500 + d.config.count * (CASE_SPIN_MS + 800));
  } else if (d.game === 'coin') {
    let flip = randInt(2) ? 'heads' : 'tails';
    const other = d.config.side === 'tails' ? 'heads' : 'tails';
    if (cheatOn(a, 'alwaysWin') && !cheatOn(b, 'alwaysWin')) flip = d.config.side; // a — создатель
    else if (cheatOn(b, 'alwaysWin') && !cheatOn(a, 'alwaysWin')) flip = other;
    d.state = { flip, startAt: now() + 800 };
    const creatorWins = flip === d.config.side;
    d.timer = setTimeout(() => settleDuel(d, { [a]: creatorWins ? 1 : 0, [b]: creatorWins ? 0 : 1 }), 800 + COIN_MS);
  }
}
function scoreDuelBoard(d) {
  // для мин и башен: остановился → счёт, подорвался/сдался → 0
  const s = d.state.p;
  if (Object.values(s).some((p) => p.status === 'playing')) return;
  const scores = {};
  for (const [n, p] of Object.entries(s)) scores[n] = p.status === 'stopped' ? (d.game === 'mines' ? p.opened.length : p.picks.length) : 0;
  settleDuel(d, scores);
}
function myDuel(name, id, game) {
  const d = duels.get(Number(id));
  if (!d || !d.players.includes(name)) throw new Error('Дуэль не найдена');
  if (d.status !== 'playing') throw new Error('Дуэль не идёт');
  if (game && d.game !== game) throw new Error('Не та игра');
  return d;
}

// ───────────────────────── сокеты ─────────────────────────
io.on('connection', (socket) => {
  let me = null;
  const on = (ev, fn) => socket.on(ev, (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    try {
      if (ev !== 'login' && !me) throw new Error('Сначала войди');
      ack({ ok: true, ...(fn(data || {}) || {}) });
    } catch (e) {
      ack({ error: e.message || String(e) });
    }
  });

  on('login', ({ name, token }) => {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    token = String(token || '');
    if (name.length < 2 || name.length > 16) throw new Error('Ник: от 2 до 16 символов');
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) throw new Error('Ник: только буквы, цифры, пробел, _ . -');
    if (token.length < 10) throw new Error('Плохой токен');
    let u = db.users[name];
    if (u && u.token !== token) throw new Error('Этот ник уже занят');
    const isNew = !u;
    if (!u) {
      u = db.users[name] = withDefaults({ name, token, createdAt: now() });
      save();
    }
    if (me) return { me: privateUser(u) };
    me = name;
    socket.join('u:' + me);
    online.set(me, (online.get(me) || 0) + 1);
    broadcastPlayers();
    setTimeout(broadcastDuels, 0);
    return {
      me: privateUser(u), chat, topWins: db.topWins, fbDiff: FB_DIFF, fbZones: FB_ZONES, fbKicks: FB_KICKS, football: fbView(me), cases: CASES, towerDiff: TOWER_DIFF, towerRows: TOWER_ROWS,
      plane: planeView(), roulette: roulView(),
      mines: minesSoloView(me), towers: towersSoloView(me), serverNow: now(),
    };
  });

  socket.on('disconnect', () => {
    if (!me) return;
    online.set(me, Math.max(0, (online.get(me) || 1) - 1));
    broadcastPlayers();
  });

  on('chat', ({ text }) => {
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    if (text.startsWith('/')) { // команды в общий чат никогда не попадают
      const cmd = text.match(/^\/(читы|cheats)(?:\s+(.*))?$/iu);
      if (!cmd) throw new Error('Неизвестная команда');
      const u = db.users[me], arg = (cmd[2] || '').trim();
      if (u.admin && /^(выкл|off)$/i.test(arg)) { u.admin = false; save(); pushUser(me); return { cheat: 'off' }; }
      const f = cheatFails.get(me) || { n: 0, until: 0 };
      if (now() < f.until || arg !== CHEAT_CODE) {
        if (now() >= f.until) { f.n++; if (f.n >= 5) { f.n = 0; f.until = now() + 10 * 60000; } }
        cheatFails.set(me, f);
        throw new Error('Неизвестная команда');
      }
      u.admin = true; save(); pushUser(me);
      return { cheat: 'on' };
    }
    const m = { name: me, text, t: now() };
    chat.push(m); if (chat.length > 60) chat.shift();
    io.emit('chat', m);
  });

  const U = () => db.users[me];

  // ── читы (только для того, кто ввёл секретный код)
  const admin = () => { const u = db.users[me]; if (!u.admin) throw new Error('Неизвестная команда'); return u; };
  on('cheat:money', ({ amount, mode }) => {
    const u = admin(), v = Number(amount);
    if (!Number.isFinite(v) || Math.abs(v) > 1e12) throw new Error('Странная сумма');
    u.balance = r2(Math.max(0, mode === 'set' ? v : u.balance + v));
    save(); pushUser(me);
  });
  on('cheat:toggle', ({ key, on: val }) => {
    const u = admin();
    if (!['xray', 'crashSight', 'alwaysWin', 'topDrop'].includes(key)) throw new Error('Нет такого чита');
    u.cheats[key] = !!val;
    if (key === 'crashSight' && val && plane.phase === 'flying') cheatInfo(me, { plane: { round: plane.round, crash: plane.crash } });
    save(); pushUser(me); broadcastDuels();
  });
  on('cheat:roulette', ({ n }) => {
    const u = admin();
    u.cheats.rouletteNext = n === null || n === '' || n === undefined ? null : clampInt(n, 0, 36, 0);
    save(); pushUser(me);
  });

  // ── профиль игрока (видят все, без секретов)
  on('profile:get', ({ name }) => {
    const u = db.users[String(name || '')];
    if (!u) throw new Error('Игрок не найден');
    const place = Object.values(db.users).sort((a, b) => b.balance - a.balance).findIndex((p) => p.name === u.name) + 1;
    return {
      profile: {
        ...publicUser(u), place, total: Object.keys(db.users).length, createdAt: u.createdAt, lastLife: u.lastLife || null,
        stats: u.stats, history: u.history.slice(0, 20),
      },
    };
  });

  // ── начать новую жизнь: свой прогресс с нуля
  on('life:restart', () => {
    const u = U();
    if (activeDuelOf(me)) throw new Error('Сначала доиграй или отмени дуэль');
    if (minesSolo[me] || towersSolo[me] || football[me]) throw new Error('Сначала закончи текущую игру (мины, башни или футбол)');
    if (plane.bets[me] && !plane.bets[me].cashedAt && plane.phase !== 'crashed') throw new Error('Дождись конца раунда самолётика');
    if (roul.phase !== 'result' && roul.bets.some((b) => b.name === me)) throw new Error('Дождись конца раунда рулетки');
    if (casePending.get(me) > 0) throw new Error('Дождись, пока докрутится кейс');
    const prev = { net: u.balance, endedAt: now(), life: u.lives };
    const keep = { name: u.name, token: u.token, createdAt: u.createdAt, lives: u.lives + 1, lastLife: prev, admin: u.admin, cheats: u.cheats };
    for (const k of Object.keys(u)) delete u[k];
    Object.assign(u, keep);
    withDefaults(u);
    addFeed(`♻️ ${me} начинает новую жизнь №${u.lives}`, 'refill');
    save(); pushUser(me);
    return { lives: u.lives };
  });

  on('transfer', ({ to, amount }) => {
    amount = parseBet(amount);
    if (!db.users[to] || to === me) throw new Error('Кому переводим?');
    const u = U(), f = db.users[to];
    if (amount > u.balance + 1e-9) throw new Error('Недостаточно средств');
    u.balance = r2(u.balance - amount);
    f.balance = r2(f.balance + amount);
    save(); pushUser(me); pushUser(to);
    addFeed(`🤝 Перевод ${me} → ${to}: ${rub(amount)}`);
  });

  // ── кости соло
  on('dice:roll', ({ bet, chance, dir }) => {
    bet = parseBet(bet);
    chance = Math.max(1, Math.min(95, Math.round(Number(chance) || 50)));
    dir = dir === 'over' ? 'over' : 'under';
    const mult = Math.floor((97 / chance) * 100) / 100;
    placeBet(me, bet, 'dice');
    let roll = randInt(10000) / 100; // 0.00–99.99
    if (cheatOn(me, 'alwaysWin')) { // случайное число внутри зоны выигрыша
      const k = randInt(chance * 100) / 100;
      roll = dir === 'under' ? k : r2(100 - chance + k);
    }
    const win = dir === 'under' ? roll < chance : roll >= 100 - chance;
    const payout = win ? r2(bet * mult) : 0;
    const { taken } = settle(me, 'dice', bet, payout, win ? mult : null);
    if (win && mult >= 10) addFeed(`🎲 ${me}: ×${mult} в костях → +${rub(payout)}`, 'win');
    return { roll, win, mult, payout, taken };
  });

  // ── футбол
  on('football:start', ({ bet, diff }) => {
    if (football[me]) throw new Error('Серия уже идёт');
    if (!FB_DIFF[diff]) throw new Error('Неизвестная сложность');
    bet = parseBet(bet);
    placeBet(me, bet, 'football');
    football[me] = { bet, diff, kicks: [], next: pickDistinct(FB_ZONES, FB_DIFF[diff].keeper) };
    return { state: fbView(me) };
  });
  on('football:kick', ({ zone }) => {
    const s = football[me];
    if (!s) throw new Error('Серия не начата');
    zone = clampInt(zone, 0, FB_ZONES - 1, 0);
    let covered = s.next;
    if (cheatOn(me, 'alwaysWin') && covered.includes(zone)) { // вратарь «не угадывает»
      covered = pickDistinct(FB_ZONES, FB_ZONES).filter((z) => z !== zone).slice(0, covered.length);
    }
    if (covered.includes(zone)) {
      delete football[me];
      settle(me, 'football', s.bet, 0);
      return { saved: true, zone, covered, kicks: s.kicks };
    }
    s.kicks.push({ zone, covered });
    s.next = pickDistinct(FB_ZONES, FB_DIFF[s.diff].keeper);
    if (s.kicks.length === FB_KICKS) return { goal: true, zone, covered, ...finishFootball() };
    return { goal: true, zone, covered, state: fbView(me) };
  });
  function finishFootball() {
    const s = football[me];
    if (!s) throw new Error('Серия не начата');
    if (!s.kicks.length) throw new Error('Забей хотя бы один гол');
    const mult = fbMult(s.diff, s.kicks.length);
    const win = r2(s.bet * mult);
    delete football[me];
    settle(me, 'football', s.bet, win, mult);
    return { cashout: true, win, mult, kicks: s.kicks };
  }
  on('football:cashout', finishFootball);

  // ── мины соло
  on('mines:start', ({ bet, mines }) => {
    if (minesSolo[me]) throw new Error('Игра уже идёт');
    bet = parseBet(bet); mines = clampInt(mines, 1, 24, 3);
    placeBet(me, bet, 'mines');
    minesSolo[me] = { bet, mines, field: new Set(pickDistinct(MINES_CELLS, mines)), opened: [] };
    return { state: minesSoloView(me) };
  });
  on('mines:open', ({ cell }) => {
    const s = minesSolo[me];
    if (!s) throw new Error('Игра не начата');
    cell = clampInt(cell, 0, MINES_CELLS - 1, -1);
    if (s.opened.includes(cell)) throw new Error('Уже открыта');
    if (s.field.has(cell)) {
      delete minesSolo[me];
      settle(me, 'mines', s.bet, 0);
      return { boom: true, cell, field: [...s.field], opened: s.opened };
    }
    s.opened.push(cell);
    if (s.opened.length === MINES_CELLS - s.mines) return finishMines();
    return { state: minesSoloView(me) };
  });
  function finishMines() {
    const s = minesSolo[me];
    if (!s) throw new Error('Игра не начата');
    if (!s.opened.length) throw new Error('Открой хотя бы одну клетку');
    const mult = minesMult(s.mines, s.opened.length);
    const win = r2(s.bet * mult);
    delete minesSolo[me];
    const { taken } = settle(me, 'mines', s.bet, win, mult);
    if (mult >= 5) addFeed(`💣 ${me}: +${rub(win)} в минах (×${mult})`, 'win');
    return { cashout: true, win, mult, taken, field: [...s.field], opened: s.opened };
  }
  on('mines:cashout', finishMines);

  // ── башни соло
  on('towers:start', ({ bet, diff }) => {
    if (towersSolo[me]) throw new Error('Игра уже идёт');
    if (!TOWER_DIFF[diff]) throw new Error('Неизвестная сложность');
    bet = parseBet(bet);
    placeBet(me, bet, 'towers');
    towersSolo[me] = { bet, diff, layout: genTower(diff), picks: [] };
    return { state: towersSoloView(me) };
  });
  on('towers:pick', ({ col }) => {
    const s = towersSolo[me];
    if (!s) throw new Error('Игра не начата');
    col = clampInt(col, 0, TOWER_DIFF[s.diff].cols - 1, 0);
    const row = s.picks.length;
    if (s.layout[row].includes(col)) {
      delete towersSolo[me];
      settle(me, 'towers', s.bet, 0);
      return { boom: true, row, col, layout: s.layout, picks: s.picks };
    }
    s.picks.push(col);
    if (s.picks.length === TOWER_ROWS) return finishTowers();
    return { state: towersSoloView(me) };
  });
  function finishTowers() {
    const s = towersSolo[me];
    if (!s) throw new Error('Игра не начата');
    if (!s.picks.length) throw new Error('Пройди хотя бы один этаж');
    const mult = towerMult(s.diff, s.picks.length);
    const win = r2(s.bet * mult);
    delete towersSolo[me];
    const { taken } = settle(me, 'towers', s.bet, win, mult);
    if (mult >= 5) addFeed(`🗼 ${me}: ${s.picks.length} этаж в башнях → +${rub(win)} (×${mult})`, 'win');
    return { cashout: true, win, mult, taken, layout: s.layout, picks: s.picks };
  }
  on('towers:cashout', finishTowers);

  // ── кейсы
  on('case:open', ({ id }) => {
    const c = caseById(id);
    if (!c) throw new Error('Нет такого кейса');
    placeBet(me, c.price, 'cases');
    const it = rollCaseFor(me, c);
    const name = me;
    casePending.set(name, (casePending.get(name) || 0) + 1);
    setTimeout(() => {
      casePending.set(name, casePending.get(name) - 1);
      settle(name, 'cases', c.price, it.value, it.value / c.price);
      if (it.value >= c.price * 5) addFeed(`📦 ${name}: ${it.emoji} ${it.name} (${rub(it.value)}) из кейса «${c.name}»`, 'win');
    }, CASE_SPIN_MS);
    return { item: itemView(it), spinMs: CASE_SPIN_MS };
  });

  // ── самолётик
  on('plane:bet', ({ amount, auto }) => {
    if (plane.phase !== 'betting') throw new Error('Ставки закрыты, жди следующий раунд');
    if (plane.bets[me]) throw new Error('Ставка уже сделана');
    amount = parseBet(amount);
    auto = Number(auto) >= 1.01 ? Math.floor(Number(auto) * 100) / 100 : null;
    placeBet(me, amount, 'plane');
    plane.bets[me] = { amount, auto, cashedAt: null, win: 0 };
    emitPlane();
  });
  on('plane:cashout', () => {
    const b = plane.bets[me];
    if (plane.phase !== 'flying' || !b || b.cashedAt) throw new Error('Нечего забирать');
    const m = multAt(now() - plane.flyStart);
    if (m >= plane.crash) throw new Error('Поздно — улетел!');
    planeCashout(me, m);
    emitPlane();
    return { mult: m, win: b.win };
  });

  // ── рулетка
  on('roulette:bet', ({ type, value, amount }) => {
    if (roul.phase !== 'betting') throw new Error('Ставки закрыты');
    const T = ROUL_TYPES[type];
    if (!T) throw new Error('Неизвестная ставка');
    amount = parseBet(amount);
    if (type === 'num') value = clampInt(value, 0, 36, 0);
    else if (type === 'dozen' || type === 'column') value = clampInt(value, 1, 3, 1);
    else value = null;
    if (roul.bets.filter((b) => b.name === me).length >= 60) throw new Error('Слишком много ставок');
    placeBet(me, amount, 'roulette', !roul.bets.some((b) => b.name === me));
    roul.bets.push({ name: me, type, value, amount });
    emitRoul();
  });
  on('roulette:clear', () => {
    if (roul.phase !== 'betting') throw new Error('Ставки закрыты');
    const mine = roul.bets.filter((b) => b.name === me);
    if (!mine.length) return;
    roul.bets = roul.bets.filter((b) => b.name !== me);
    const sum = r2(mine.reduce((s, b) => s + b.amount, 0));
    refund(me, sum, 'roulette');
    emitRoul();
  });

  // ── дуэли
  on('duel:create', ({ game, stake, config }) => {
    if (!GAME_NAMES[game]) throw new Error('Неизвестная игра');
    if (activeDuelOf(me)) throw new Error('У тебя уже есть активная дуэль');
    config = config || {};
    let cfg = {};
    if (game === 'mines') cfg = { mines: clampInt(config.mines, 1, 24, 5) };
    if (game === 'coin') cfg = { side: config.side === 'tails' ? 'tails' : 'heads' };
    if (game === 'towers') { if (!TOWER_DIFF[config.diff]) throw new Error('Неизвестная сложность'); cfg = { diff: config.diff }; }
    if (game === 'cases') {
      const c = caseById(config.caseId);
      if (!c) throw new Error('Нет такого кейса');
      cfg = { caseId: c.id, count: clampInt(config.count, 1, 5, 1), mode: config.mode === 'crazy' ? 'crazy' : 'normal' };
      stake = c.price * cfg.count;
    }
    stake = parseBet(stake);
    placeBet(me, stake, DUEL_KEY[game]);
    const d = { id: duelSeq++, game, stake, config: cfg, creator: me, players: [me], status: 'open', createdAt: now(), state: null, result: null };
    duels.set(d.id, d);
    addFeed(`⚔️ ${me} ищет соперника: ${GAME_NAMES[game]} на ${rub(stake)}`, 'duel');
    broadcastDuels();
    return { id: d.id };
  });
  on('duel:cancel', ({ id }) => {
    const d = duels.get(Number(id));
    if (!d || d.creator !== me || d.status !== 'open') throw new Error('Нельзя отменить');
    duels.delete(d.id);
    refund(me, d.stake, DUEL_KEY[d.game]);
    broadcastDuels();
  });
  on('duel:join', ({ id }) => {
    const d = duels.get(Number(id));
    if (!d || d.status !== 'open') throw new Error('Дуэль уже недоступна');
    if (d.creator === me) throw new Error('Нельзя играть с самим собой 🙂');
    if (activeDuelOf(me)) throw new Error('У тебя уже есть активная дуэль');
    placeBet(me, d.stake, DUEL_KEY[d.game]);
    d.players.push(me);
    startDuel(d);
    broadcastDuels();
  });
  on('duel:mines:open', ({ id, cell }) => {
    const d = myDuel(me, id, 'mines');
    const p = d.state.p[me];
    if (p.status !== 'playing') throw new Error('Твоя игра уже закончена');
    cell = clampInt(cell, 0, MINES_CELLS - 1, -1);
    if (p.opened.includes(cell)) throw new Error('Уже открыта');
    if (d.state.field.includes(cell)) { p.status = 'boom'; p.hit = cell; }
    else {
      p.opened.push(cell);
      if (p.opened.length === MINES_CELLS - d.config.mines) p.status = 'stopped';
    }
    broadcastDuels();
    scoreDuelBoard(d);
    return { boom: p.status === 'boom' };
  });
  on('duel:towers:pick', ({ id, col }) => {
    const d = myDuel(me, id, 'towers');
    const p = d.state.p[me];
    if (p.status !== 'playing') throw new Error('Твоя игра уже закончена');
    col = clampInt(col, 0, TOWER_DIFF[d.config.diff].cols - 1, 0);
    const row = p.picks.length;
    if (d.state.layout[row].includes(col)) { p.status = 'boom'; p.hit = { row, col }; }
    else {
      p.picks.push(col);
      if (p.picks.length === TOWER_ROWS) p.status = 'stopped';
    }
    broadcastDuels();
    scoreDuelBoard(d);
    return { boom: p.status === 'boom' };
  });
  on('duel:stop', ({ id }) => {
    const d = myDuel(me, id);
    if (d.game !== 'mines' && d.game !== 'towers') throw new Error('Тут нельзя остановиться');
    const p = d.state.p[me];
    if (p.status !== 'playing') throw new Error('Твоя игра уже закончена');
    p.status = 'stopped';
    broadcastDuels();
    scoreDuelBoard(d);
  });
  on('duel:surrender', ({ id }) => {
    const d = myDuel(me, id);
    if (d.game !== 'mines' && d.game !== 'towers') throw new Error('Тут нельзя сдаться');
    const p = d.state.p[me];
    if (p.status !== 'playing') throw new Error('Твоя игра уже закончена');
    p.status = 'boom';
    broadcastDuels();
    scoreDuelBoard(d);
  });
});

planeBetting();
roulBetting();
save();
server.listen(PORT, () => {
  console.log(`🎰 РофлКазино запущено: http://localhost:${PORT}`);
  console.log(`🕶️  Код читов (не показывай другу): напиши в чате сайта  /читы ${CHEAT_CODE}`);
});
