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

// ───────────────────────── мама-банк: настройки ─────────────────────────
const TIME_SCALE = Number(process.env.DEBT_TIME_SCALE) > 0 ? Number(process.env.DEBT_TIME_SCALE) : 1;
const MIN = 60000 * TIME_SCALE; // «минута» долга
const START_TRUST = 60;
const MAX_LOANS = 3;
const ARREST_MAX = 1000;
const PENALTY_RATE = 0.03;
const STAGE_MIN = { 1: 0, 2: 3, 3: 10 }; // стадии просрочки (минут после дедлайна)
const GRANDMA_CD = 30 * 60000;
const LOAN_PLANS = [
  { id: 'bread', name: 'На хлебушек', emoji: '🍞', amount: 5000, rate: 0.10, minutes: 10, minTrust: 0 },
  { id: 'phone', name: 'На телефон', emoji: '📱', amount: 15000, rate: 0.20, minutes: 20, minTrust: 30 },
  { id: 'talk', name: 'Серьёзный разговор', emoji: '🗣️', amount: 30000, rate: 0.30, minutes: 30, minTrust: 50 },
  { id: 'flat', name: 'Под залог квартиры', emoji: '🏠', amount: 75000, rate: 0.50, minutes: 45, minTrust: 75 },
];
const JOBS = {
  dishes: { id: 'dishes', name: 'Помыть посуду', emoji: '🍽️', pay: 300, secs: 10, cd: 60 },
  dog: { id: 'dog', name: 'Выгулять собаку', emoji: '🐕', pay: 800, secs: 30, cd: 180 },
  shop: { id: 'shop', name: 'Сходить в магазин', emoji: '🛒', pay: 1500, secs: 60, cd: 360 },
  homework: { id: 'homework', name: 'Сделать уроки брату', emoji: '📚', pay: 3000, secs: 120, cd: 900 },
};
const MOM_LINES = {
  loan: ['Ладно, держи {amount}. Но вернуть {owe} — через {min} мин, поняли друг друга?', 'Это последний раз. Честно последний. Жду {owe} через {min} мин.', 'Только папе не говори. Срок — {min} мин.', 'Я в твои годы уже на заводе работала... Ладно, держи. Вернуть {owe}.', 'Опять казино? Ох... {amount}, и чтобы через {min} мин было {owe}.'],
  remind: ['⏰ Напоминаю: долг {owe}, осталось совсем чуть-чуть.', '⏰ Ты же помнишь про {owe}? Я вот помню.', '⏰ Скоро срок. Не заставляй меня звонить.'],
  stage1: ['📞 Пропущенный вызов: Мама (3)', '📞 Почему не берёшь трубку?! Срок вышел!', '📞 Я жду. Пеня капает, между прочим, 3% в минуту.', '📞 Я тебе вообще-то мать, а не банк. Где деньги?'],
  stage2: ['😡 Всё. Теперь половина твоих выигрышей — моя, пока не вернёшь.', '😡 Карту твою я заблокировала. Буду забирать половину выигрыша.', '😡 Я позвонила тёте Свете. Она тоже в шоке. Конфискую выигрыши.'],
  stage3: ['🔒 Домашний арест! Ставки не больше 1 000 ₽, пока не вернёшь долг.', '🔒 Папа уже в курсе. Сидишь дома, играешь по мелочи.', '🔒 Wi-Fi отключать не буду, но ставки — максимум 1 000 ₽.'],
  extend: ['Ладно, ещё немного подожду. Но +10%!', 'Отсрочка. Последняя. Честно-честно последняя.', 'Хорошо, но я это запомню.'],
  paidOk: ['🥰 Молодец! Вот видишь, можешь же.', '🥰 Спасибо, солнышко. Доверие растёт.', '🥰 Вовремя! Может, ещё и посуду помоешь?'],
  paidLate: ['Ну наконец-то. Но я это запомню.', 'Деньги вернулись... но осадочек остался.', 'Хорошо, что вернул(а). Плохо, что так поздно.'],
  refuse: ['Хватит с тебя. Сначала верни старое.'],
  job: ['Спасибо за помощь! Держи {pay}.', 'Вот это я понимаю — полезный ребёнок. +{pay}.'],
  helped: ['Передай другу спасибо, он(а) закрыл(а) {amount} твоего долга.'],
  newLife: ['Ладно. Начнём с чистого листа. Но я всё помню.', 'Новая жизнь? Хорошо. Только в казино больше ни-ни... ну ты понял(а).', 'Долги прощаю. Один раз. Ну, может, два.', 'Ох... Ладно, держи 10 000 ₽ и начинай заново.'],
};

// ───────────────────────── игроки ─────────────────────────
function withDefaults(u) {
  u.balance ??= START_BALANCE; u.wagered ??= 0; u.best ??= 0; u.lives ??= 1;
  u.trust ??= START_TRUST; u.loans ??= []; u.loanSeq ??= 1;
  u.mom ??= []; u.history ??= []; u.jobCd ??= {}; u.job ??= null; u.grandmaAt ??= 0;
  u.admin ??= false; u.cheats ??= {};
  u.stats ??= {};
  for (const k of ['borrowed', 'repaid', 'penalties', 'overdue', 'onTime', 'late', 'jobs', 'jobsEarned', 'grandma', 'confiscated', 'helped', 'propIncome', 'propSpent']) u.stats[k] ??= 0;
  u.props ??= []; u.propSeq ??= 1;
  u.stats.games ??= {};
  delete u.refills;
  return u;
}
for (const u of Object.values(db.users)) withDefaults(u);

const online = new Map(); // name -> кол-во подключений
const activeLoans = (u) => u.loans.filter((l) => l.status === 'active');
const debtOf = (u) => r2(activeLoans(u).reduce((s, l) => s + l.owed, 0));
const creditLimit = (u) => 10000 + Math.round(u.trust) * 1000;
const clampTrust = (x) => Math.max(0, Math.min(100, Math.round(x)));
function loanStage(l, t = now()) {
  if (l.status !== 'active' || t < l.dueAt) return 0;
  const m = (t - l.dueAt) / MIN;
  return m >= STAGE_MIN[3] ? 3 : m >= STAGE_MIN[2] ? 2 : 1;
}
// чит включён у игрока? (только у админа)
const cheatOn = (name, k) => { const u = db.users[name]; return !!(u && u.admin && u.cheats[k]); };
function cheatInfo(name, data) { io.to('u:' + name).emit('cheatInfo', data); }
const momStage = (u) => activeLoans(u).reduce((s, l) => Math.max(s, loanStage(l)), 0);
const publicUser = (u) => {
  const debt = debtOf(u);
  return {
    name: u.name, balance: u.balance, debt, assets: assetsOf(u), props: u.props.length,
    net: r2(u.balance - debt + assetsOf(u)), trust: u.trust, stage: momStage(u),
    best: u.best, wagered: u.wagered, lives: u.lives, online: (online.get(u.name) || 0) > 0,
  };
};
const privateUser = (u) => ({
  ...publicUser(u),
  limit: creditLimit(u),
  loans: u.loans, mom: u.mom, history: u.history, stats: u.stats,
  admin: u.admin, cheats: u.admin ? u.cheats : {},
  estate: u.props.map((p) => propView(u, p)),
  job: u.job, jobCd: u.jobCd, grandmaAt: u.grandmaAt, lastLife: u.lastLife || null, serverNow: now(),
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
    io.emit('players', Object.values(db.users).map(publicUser).sort((a, b) => b.net - a.net));
  }, 50);
}
function momSay(u, kind, vars = {}, toFeed = false) {
  const list = MOM_LINES[kind];
  const text = list[randInt(list.length)].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const m = { t: now(), text, kind };
  u.mom.unshift(m); u.mom.length = Math.min(u.mom.length, 40);
  io.to('u:' + u.name).emit('mom', m);
  if (toFeed) addFeed(`👩 Мама игрока ${u.name}: «${text}»`, 'mom');
}

// ───────────────────────── деньги: ставки и выплаты ─────────────────────────
const gameStats = (u, game) => (u.stats.games[game] ??= { played: 0, won: 0, wagered: 0, returned: 0 });
function placeBet(name, amount, game, count = true) {
  const u = db.users[name];
  if (!(amount > 0) || amount > u.balance + 1e-9) throw new Error('Недостаточно средств');
  if (amount > ARREST_MAX && momStage(u) >= 3) throw new Error(`🔒 Домашний арест: ставка не больше ${rub(ARREST_MAX)}. Верни долг маме!`);
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
// выплата по завершённой ставке (payout = 0 — проигрыш); тут же конфискация мамой
function settle(name, game, stake, payout, mult) {
  const u = db.users[name];
  if (!u) return { kept: 0, taken: 0 };
  payout = r2(payout || 0);
  const g = gameStats(u, game);
  g.returned = r2(g.returned + payout);
  if (payout > stake) g.won++;
  let taken = 0;
  const profit = payout - stake;
  if (profit > 0 && momStage(u) >= 2) {
    taken = r2(Math.min(profit * 0.5, debtOf(u)));
    if (taken > 0) {
      u.stats.confiscated = r2(u.stats.confiscated + taken);
      repayLoans(u, taken);
      io.to('u:' + name).emit('confiscated', { amount: taken });
    }
  }
  const kept = r2(payout - taken);
  u.balance = r2(u.balance + kept);
  if (mult && mult > 1 && mult > u.best) u.best = r2(mult);
  u.history.unshift({ t: now(), game, stake, payout, taken });
  u.history.length = Math.min(u.history.length, 40);
  save(); pushUser(name);
  return { kept, taken };
}

// ───────────────────────── долги ─────────────────────────
function payLoan(u, l, amount) {
  const pay = r2(Math.min(amount, l.owed));
  l.owed = r2(l.owed - pay); l.paid = r2(l.paid + pay);
  u.stats.repaid = r2(u.stats.repaid + pay);
  if (l.owed < 0.01) closeLoan(u, l);
  return pay;
}
function repayLoans(u, amount) { // самые ранние дедлайны — первыми
  for (const l of activeLoans(u).sort((a, b) => a.dueAt - b.dueAt)) {
    if (amount < 0.01) break;
    amount = r2(amount - payLoan(u, l, amount));
  }
}
function closeLoan(u, l) {
  l.owed = 0; l.status = 'paid'; l.paidAt = now();
  if (l.wasOverdue) { u.trust = clampTrust(u.trust + 2); u.stats.late++; momSay(u, 'paidLate', {}, true); }
  else { u.trust = clampTrust(u.trust + 8); u.stats.onTime++; momSay(u, 'paidOk'); addFeed(`✅ ${u.name} вовремя вернул(а) маме ${rub(l.base)} (${l.emoji} ${l.name})`, 'mom'); }
  const closed = u.loans.filter((x) => x.status !== 'active');
  if (closed.length > 15) { const drop = new Set(closed.slice(15)); u.loans = u.loans.filter((x) => !drop.has(x)); }
}
// ───────────────────────── имущество ─────────────────────────
const PROPS = {
  room: { kind: 'flat', name: 'Комната в общаге', emoji: '🏚️', price: 25000, income: 200 },
  studio: { kind: 'flat', name: 'Однушка в спальнике', emoji: '🏠', price: 80000, income: 650 },
  center: { kind: 'flat', name: 'Двушка в центре', emoji: '🏢', price: 200000, income: 1700 },
  penthouse: { kind: 'flat', name: 'Пентхаус в Сити', emoji: '🌆', price: 1000000, income: 8500 },
  villa: { kind: 'flat', name: 'Вилла на море', emoji: '🏝️', price: 5000000, income: 45000 },
  shawarma: { kind: 'biz', name: 'Шаурмичная', emoji: '🌯', price: 50000, income: 550 },
  wash: { kind: 'biz', name: 'Автомойка', emoji: '🚗', price: 150000, income: 1600 },
  club: { kind: 'biz', name: 'Компьютерный клуб', emoji: '🎮', price: 400000, income: 4300 },
  bar: { kind: 'biz', name: 'Бар «У мамы»', emoji: '🍻', price: 1200000, income: 13000 },
  casino: { kind: 'biz', name: 'Своё казино', emoji: '🎰', price: 4000000, income: 44000 },
};
const TENANTS = [
  { name: 'Студент Вася', emoji: '🧑‍🎓', k: 0.8, risk: 0.12 },
  { name: 'Семья с котом', emoji: '🐈', k: 1.0, risk: 0.03 },
  { name: 'Айтишник на удалёнке', emoji: '🧑‍💻', k: 1.25, risk: 0.02 },
  { name: 'Блогер', emoji: '🤳', k: 1.4, risk: 0.1 },
  { name: 'Бабушка-одуванчик', emoji: '👵', k: 0.9, risk: 0 },
  { name: 'Командировочный', emoji: '🧳', k: 1.1, risk: 0.05 },
  { name: 'Рок-группа', emoji: '🎸', k: 1.5, risk: 0.18 },
  { name: 'Подозрительный тип', emoji: '🕶️', k: 1.8, risk: 0.3 },
];
const MAX_PROPS = 12, CASH_CAP_MIN = 60, OFFERS_CD = 30000, SELL_K = 0.7;
const maxLevel = (def) => (def.kind === 'flat' ? 3 : 5);
const levelMult = (def, lvl) => 1 + (def.kind === 'flat' ? 0.25 : 0.5) * (lvl - 1);
const upgradeCost = (def, lvl) => r2(def.price * (def.kind === 'flat' ? 0.3 : 0.4) * lvl);
const sellPrice = (p) => r2((PROPS[p.type].price + p.spent) * SELL_K);
function propRate(owner, p) { // ₽ за «минуту»
  const def = PROPS[p.type];
  if (def.kind === 'flat' && p.state !== 'rented') return 0;
  let r = def.income * levelMult(def, p.level) * (def.kind === 'flat' ? p.tenant.k : 1);
  if (cheatOn(owner, 'propBoost')) r *= 3;
  return r2(r);
}
const propCap = (owner, p) => r2(Math.max(propRate(owner, p), PROPS[p.type].income * levelMult(PROPS[p.type], p.level)) * CASH_CAP_MIN);
function accrue(owner, p, t = now()) {
  const rate = propRate(owner, p);
  if (rate > 0 && t > p.lastTick) p.cash = r2(Math.min(propCap(owner, p), p.cash + (rate * (t - p.lastTick)) / MIN));
  p.lastTick = Math.max(p.lastTick, t);
}
const assetsOf = (u) => r2(u.props.reduce((s, p) => s + sellPrice(p), 0));
function propView(u, p) {
  const def = PROPS[p.type];
  return {
    id: p.id, type: p.type, level: p.level, state: p.state, tenant: p.tenant, rentUntil: p.rentUntil,
    offers: p.offers, offersAt: p.offersAt, cash: p.cash, lastTick: p.lastTick,
    rate: propRate(u.name, p), cap: propCap(u.name, p), sell: sellPrice(p),
    upgrade: p.level < maxLevel(def) ? upgradeCost(def, p.level) : null, maxLevel: maxLevel(def),
  };
}
function genOffers(def) {
  return pickDistinct(TENANTS.length, 3).map((i) => ({ ...TENANTS[i], mins: 15 + randInt(26) }));
}
function propEvent(u, text, toFeed = false) {
  io.to('u:' + u.name).emit('propEvent', { text });
  if (toFeed) addFeed(text, 'mom');
}
// раз в «минуту» на каждый объект: конец договора, побеги жильцов, события бизнеса
function propTick(u, t) {
  let changed = false;
  for (const p of u.props) {
    const def = PROPS[p.type];
    if (def.kind === 'flat' && p.state === 'rented' && t >= p.rentUntil) {
      accrue(u.name, p, p.rentUntil);
      propEvent(u, `📦 ${p.tenant.emoji} ${p.tenant.name} съехал(а) из «${def.name}». Пора искать новых жильцов.`);
      p.state = 'free'; p.tenant = null; p.lastTick = t;
      changed = true; continue;
    }
    if (t < p.nextCheck) continue;
    p.nextCheck = t + MIN;
    accrue(u.name, p, t);
    if (def.kind === 'flat' && p.state === 'rented' && rnd() < p.tenant.risk * 0.15) {
      const lost = p.cash;
      propEvent(u, `🏃 ${p.tenant.emoji} ${p.tenant.name} сбежал(а) из «${def.name}» у ${u.name}, не заплатив ${rub(lost)}!`, true);
      p.cash = 0; p.state = 'free'; p.tenant = null;
      changed = true;
    } else if (def.kind === 'biz' && rnd() < 0.03) {
      const ev = randInt(3);
      if (ev === 0) {
        const loss = r2(p.cash * 0.25); p.cash = r2(p.cash - loss);
        propEvent(u, `🧾 Налоговая проверка в «${def.name}»: −${rub(loss)} из кассы`);
      } else if (ev === 1) {
        const loss = r2(Math.min(p.cash, def.price * 0.05)); p.cash = r2(p.cash - loss);
        propEvent(u, `🔧 Поломка в «${def.name}»: ремонт ${rub(loss)} из кассы`);
      } else {
        const bonus = r2(propRate(u.name, p) * 10);
        p.cash = r2(Math.min(propCap(u.name, p), p.cash + bonus));
        propEvent(u, `🌟 Ажиотаж в «${def.name}» у ${u.name}: +${rub(bonus)} в кассу`, true);
      }
      changed = true;
    }
  }
  return changed;
}
function collectProps(u, list) {
  const t = now();
  let total = 0;
  for (const p of list) { accrue(u.name, p, t); total = r2(total + p.cash); p.cash = 0; }
  if (total <= 0) return { total: 0, taken: 0 };
  let taken = 0;
  if (momStage(u) >= 2) {
    taken = r2(Math.min(total * 0.5, debtOf(u)));
    if (taken > 0) { u.stats.confiscated = r2(u.stats.confiscated + taken); repayLoans(u, taken); io.to('u:' + u.name).emit('confiscated', { amount: taken }); }
  }
  u.balance = r2(u.balance + total - taken);
  u.stats.propIncome = r2(u.stats.propIncome + total);
  return { total, taken };
}

function momTick() {
  const t = now();
  for (const u of Object.values(db.users)) {
    let changed = false;
    if (u.job && t >= u.job.endsAt) {
      const J = JOBS[u.job.id];
      u.job = null;
      if (J) {
        u.balance = r2(u.balance + J.pay); u.trust = clampTrust(u.trust + 1);
        u.stats.jobs++; u.stats.jobsEarned = r2(u.stats.jobsEarned + J.pay);
        io.to('u:' + u.name).emit('jobDone', { name: J.name, emoji: J.emoji, pay: J.pay });
        if (randInt(3) === 0) momSay(u, 'job', { pay: rub(J.pay) });
      }
      changed = true;
    }
    for (const l of activeLoans(u)) {
      if (!l.reminded && t >= l.dueAt - 2 * MIN && t < l.dueAt) {
        l.reminded = true; momSay(u, 'remind', { owe: rub(l.owed) }); changed = true;
      }
      const st = loanStage(l, t);
      while ((l.stage || 0) < st) {
        l.stage = (l.stage || 0) + 1;
        if (l.stage === 1) { l.wasOverdue = true; u.stats.overdue++; u.trust = clampTrust(u.trust - 10); }
        else u.trust = clampTrust(u.trust - 5);
        momSay(u, 'stage' + l.stage, {}, true);
        changed = true;
      }
      if (st >= 1) {
        const mins = Math.floor((t - l.dueAt) / MIN);
        if ((l.penMin || 0) < mins) {
          if (l.penalty >= l.base) l.penMin = mins;
          while ((l.penMin || 0) < mins) {
            l.penMin = (l.penMin || 0) + 1;
            const add = r2(Math.min(l.base - l.penalty, l.owed * PENALTY_RATE));
            if (add <= 0) { l.penMin = mins; break; }
            l.owed = r2(l.owed + add); l.penalty = r2(l.penalty + add);
            u.stats.penalties = r2(u.stats.penalties + add);
          }
          changed = true;
        }
      }
    }
    if (u.props.length && propTick(u, t)) changed = true;
    if (changed) { save(); pushUser(u.name); }
  }
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
const CASE_RTP = 0.95;
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
const GAME_NAMES = { crash: 'краш-дуэль', mines: 'мины-дуэль', towers: 'башни-дуэль', cases: 'кейс-батл', coin: 'монетка' };
const DUEL_KEY = { crash: 'crash', mines: 'mines-duel', towers: 'towers-duel', cases: 'cases-battle', coin: 'coin' };
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
  if (d.game === 'crash') {
    let cash = s.cash;
    if (d.config.blind && !done) cash = viewer in s.cash ? { [viewer]: s.cash[viewer] } : {};
    base.state = { startAt: s.startAt, cash, crash: done ? s.crash : null, sight: !done && cheatOn(viewer, 'crashSight') ? s.crash : null };
  } else if (d.game === 'mines') {
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
  if (d.game === 'crash') {
    const crash = genCrash(1);
    d.state = { crash, startAt: now() + 4000, cash: {} };
    d.timer = setTimeout(() => settleDuel(d, { [a]: d.state.cash[a] || 0, [b]: d.state.cash[b] || 0 }),
      d.state.startAt - now() + timeFor(crash) + 30);
  } else if (d.game === 'mines') {
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
    if (isNew) addFeed(`👋 Новый игрок: ${me} (стартовые ${rub(START_BALANCE)})`);
    broadcastPlayers();
    setTimeout(broadcastDuels, 0);
    return {
      me: privateUser(u), feed, chat, propsCatalog: PROPS, maxProps: MAX_PROPS, loanPlans: LOAN_PLANS, jobs: JOBS, grandmaCd: GRANDMA_CD,
      arrestMax: ARREST_MAX, minuteMs: MIN, cases: CASES, towerDiff: TOWER_DIFF, towerRows: TOWER_ROWS,
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

  // ── мама-банк
  const U = () => db.users[me];
  const findLoan = (u, id) => {
    const l = u.loans.find((x) => x.id === Number(id) && x.status === 'active');
    if (!l) throw new Error('Долг не найден');
    return l;
  };
  on('mom:loan', ({ plan }) => {
    const P = LOAN_PLANS.find((p) => p.id === plan);
    if (!P) throw new Error('Нет такого тарифа');
    const u = U();
    if (momStage(u) >= 1) { momSay(u, 'refuse'); throw new Error('Мама: «Сначала верни просроченное!»'); }
    if (activeLoans(u).length >= MAX_LOANS) throw new Error(`Мама: «У тебя и так ${MAX_LOANS} долга!»`);
    if (u.trust < P.minTrust) throw new Error(`Мама не доверяет тебе такие суммы (нужно доверие ${P.minTrust})`);
    const owe = r2(P.amount * (1 + P.rate));
    if (debtOf(u) + owe > creditLimit(u)) throw new Error(`Мама: «Мой лимит для тебя — ${rub(creditLimit(u))} долга»`);
    const t = now();
    const l = {
      id: u.loanSeq++, plan: P.id, name: P.name, emoji: P.emoji, principal: P.amount, rate: P.rate, minutes: P.minutes,
      base: owe, owed: owe, paid: 0, penalty: 0, takenAt: t, dueAt: t + P.minutes * MIN,
      status: 'active', stage: 0, extended: false, wasOverdue: false, reminded: false, penMin: 0,
    };
    u.loans.unshift(l);
    u.balance = r2(u.balance + P.amount);
    u.stats.borrowed = r2(u.stats.borrowed + P.amount);
    u.trust = clampTrust(u.trust - 2);
    momSay(u, 'loan', { amount: rub(P.amount), owe: rub(owe), min: P.minutes });
    addFeed(`💸 ${me} занимает у мамы ${rub(P.amount)} (${P.emoji} ${P.name}) — вернуть ${rub(owe)} за ${P.minutes} мин`, 'refill');
    save(); pushUser(me);
  });
  on('mom:repay', ({ id, amount }) => {
    const u = U();
    const l = findLoan(u, id);
    amount = amount === 'all' ? Math.min(l.owed, u.balance) : Math.min(parseBet(amount), l.owed);
    amount = r2(amount);
    if (!(amount > 0)) throw new Error('Нечем платить');
    if (amount > u.balance + 1e-9) throw new Error('Недостаточно средств');
    u.balance = r2(u.balance - amount);
    payLoan(u, l, amount);
    save(); pushUser(me);
    return { paid: amount, closed: l.status !== 'active' };
  });
  on('mom:extend', ({ id }) => {
    const u = U();
    const l = findLoan(u, id);
    if (l.extended) throw new Error('Отсрочка уже была');
    if (now() >= l.dueAt) throw new Error('Поздно просить отсрочку — срок уже вышел');
    const add = r2(l.owed * 0.1);
    l.extended = true; l.reminded = false;
    l.dueAt += Math.ceil(l.minutes / 2) * MIN;
    l.owed = r2(l.owed + add); l.base = r2(l.base + add);
    u.trust = clampTrust(u.trust - 5);
    momSay(u, 'extend');
    save(); pushUser(me);
  });
  on('mom:payFor', ({ to, amount }) => {
    const f = db.users[to];
    if (!f || to === me) throw new Error('За кого платим?');
    const debt = debtOf(f);
    if (!(debt > 0)) throw new Error(`У ${to} нет долгов`);
    amount = r2(Math.min(parseBet(amount), debt));
    const u = U();
    if (amount > u.balance + 1e-9) throw new Error('Недостаточно средств');
    u.balance = r2(u.balance - amount);
    u.stats.helped = r2(u.stats.helped + amount);
    repayLoans(f, amount);
    momSay(f, 'helped', { amount: rub(amount) });
    addFeed(`🦸 ${me} закрывает ${rub(amount)} долга ${to} перед мамой`, 'mom');
    save(); pushUser(me); pushUser(to);
    return { paid: amount };
  });
  on('job:start', ({ id }) => {
    const J = JOBS[id];
    if (!J) throw new Error('Нет такой работы');
    const u = U();
    if (u.job) throw new Error('Ты уже работаешь');
    if (now() < (u.jobCd[id] || 0)) throw new Error('Эта работа ещё на перезарядке');
    u.job = { id, startedAt: now(), endsAt: now() + J.secs * 1000 };
    u.jobCd[id] = u.job.endsAt + J.cd * 1000;
    save(); pushUser(me);
  });
  on('grandma', () => {
    const u = U();
    if (now() < u.grandmaAt + GRANDMA_CD) throw new Error('Бабушка спит, приходи позже');
    const amount = 1000 + randInt(5) * 500;
    u.grandmaAt = now();
    u.balance = r2(u.balance + amount);
    u.stats.grandma = r2(u.stats.grandma + amount);
    addFeed(`👵 Бабушка дала ${me} ${rub(amount)} на мороженое`, 'win');
    save(); pushUser(me);
    return { amount };
  });

  // ── читы (только для того, кто ввёл секретный код)
  const admin = () => { const u = db.users[me]; if (!u.admin) throw new Error('Неизвестная команда'); return u; };
  on('cheat:money', ({ amount, mode }) => {
    const u = admin(), v = Number(amount);
    if (!Number.isFinite(v) || Math.abs(v) > 1e12) throw new Error('Странная сумма');
    u.balance = r2(Math.max(0, mode === 'set' ? v : u.balance + v));
    save(); pushUser(me);
  });
  on('cheat:forgive', () => {
    const u = admin();
    for (const l of activeLoans(u)) { l.status = 'paid'; l.forgiven = true; l.paidAt = now(); l.owed = 0; }
    save(); pushUser(me);
  });
  on('cheat:trust', () => { const u = admin(); u.trust = 100; save(); pushUser(me); });
  on('cheat:cooldowns', () => {
    const u = admin();
    u.jobCd = {}; u.grandmaAt = 0;
    if (u.job) u.job.endsAt = now();
    save(); pushUser(me);
  });
  on('cheat:toggle', ({ key, on: val }) => {
    const u = admin();
    if (!['xray', 'crashSight', 'alwaysWin', 'topDrop', 'propBoost'].includes(key)) throw new Error('Нет такого чита');
    if (key === 'propBoost') for (const p of u.props) accrue(me, p); // зафиксировать кассу по старой ставке
    u.cheats[key] = !!val;
    if (key === 'crashSight' && val && plane.phase === 'flying') cheatInfo(me, { plane: { round: plane.round, crash: plane.crash } });
    save(); pushUser(me); broadcastDuels();
  });
  on('cheat:roulette', ({ n }) => {
    const u = admin();
    u.cheats.rouletteNext = n === null || n === '' || n === undefined ? null : clampInt(n, 0, 36, 0);
    save(); pushUser(me);
  });

  // ── имущество
  const myProp = (u, id) => {
    const p = u.props.find((x) => x.id === Number(id));
    if (!p) throw new Error('Объект не найден');
    return p;
  };
  on('prop:buy', ({ type }) => {
    const def = PROPS[type], u = U();
    if (!def) throw new Error('Нет такого объекта');
    if (u.props.length >= MAX_PROPS) throw new Error(`Не больше ${MAX_PROPS} объектов`);
    if (momStage(u) >= 3) throw new Error('🔒 Домашний арест: мама не разрешает ничего покупать');
    if (def.price > u.balance + 1e-9) throw new Error('Недостаточно средств');
    u.balance = r2(u.balance - def.price);
    u.stats.propSpent = r2(u.stats.propSpent + def.price);
    const t = now();
    const p = { id: u.propSeq++, type, level: 1, spent: 0, cash: 0, lastTick: t, nextCheck: t + MIN, boughtAt: t,
      state: def.kind === 'flat' ? 'free' : 'working', tenant: null, rentUntil: 0, offers: null, offersAt: 0 };
    u.props.push(p);
    addFeed(`🏢 ${me} покупает ${def.emoji} «${def.name}» за ${rub(def.price)}`, 'win');
    save(); pushUser(me);
    return { id: p.id };
  });
  on('prop:offers', ({ id }) => {
    const u = U(), p = myProp(u, id), def = PROPS[p.type];
    if (def.kind !== 'flat') throw new Error('Бизнес не сдаётся');
    if (p.state === 'rented') throw new Error('Квартира уже сдана');
    if (p.offers && now() < p.offersAt + OFFERS_CD) throw new Error('Новые жильцы появятся чуть позже');
    p.offers = genOffers(def); p.offersAt = now();
    save(); pushUser(me);
  });
  on('prop:rent', ({ id, idx }) => {
    const u = U(), p = myProp(u, id);
    if (p.state === 'rented') throw new Error('Квартира уже сдана');
    const o = p.offers && p.offers[clampInt(idx, 0, 2, 0)];
    if (!o) throw new Error('Сначала найди жильцов');
    const t = now();
    p.state = 'rented'; p.tenant = { name: o.name, emoji: o.emoji, k: o.k, risk: o.risk };
    p.rentUntil = t + o.mins * MIN; p.lastTick = t; p.nextCheck = t + MIN; p.offers = null;
    save(); pushUser(me);
  });
  on('prop:evict', ({ id }) => {
    const u = U(), p = myProp(u, id);
    if (p.state !== 'rented') throw new Error('Там никто не живёт');
    accrue(me, p); p.state = 'free'; p.tenant = null;
    save(); pushUser(me);
  });
  on('prop:collect', ({ id }) => {
    const u = U();
    const list = id === 'all' ? u.props : [myProp(u, id)];
    const r = collectProps(u, list);
    if (!r.total) throw new Error('Касса пуста');
    save(); pushUser(me);
    return r;
  });
  on('prop:upgrade', ({ id }) => {
    const u = U(), p = myProp(u, id), def = PROPS[p.type];
    if (p.level >= maxLevel(def)) throw new Error('Уже максимальный уровень');
    const cost = upgradeCost(def, p.level);
    if (cost > u.balance + 1e-9) throw new Error('Недостаточно средств');
    accrue(me, p);
    u.balance = r2(u.balance - cost); u.stats.propSpent = r2(u.stats.propSpent + cost);
    p.spent = r2(p.spent + cost); p.level++;
    save(); pushUser(me);
    return { level: p.level };
  });
  on('prop:sell', ({ id }) => {
    const u = U(), p = myProp(u, id), def = PROPS[p.type];
    const { total } = collectProps(u, [p]);
    const price = sellPrice(p);
    u.balance = r2(u.balance + price);
    u.props = u.props.filter((x) => x !== p);
    addFeed(`💼 ${me} продаёт ${def.emoji} «${def.name}» за ${rub(price)}`);
    save(); pushUser(me);
    return { price, cash: total };
  });

  // ── начать новую жизнь: свой прогресс с нуля
  on('life:restart', () => {
    const u = U();
    if (activeDuelOf(me)) throw new Error('Сначала доиграй или отмени дуэль');
    if (minesSolo[me] || towersSolo[me]) throw new Error('Сначала закончи текущую игру в минах или башнях');
    if (plane.bets[me] && !plane.bets[me].cashedAt && plane.phase !== 'crashed') throw new Error('Дождись конца раунда самолётика');
    if (roul.phase !== 'result' && roul.bets.some((b) => b.name === me)) throw new Error('Дождись конца раунда рулетки');
    if (casePending.get(me) > 0) throw new Error('Дождись, пока докрутится кейс');
    const prev = { net: r2(u.balance - debtOf(u) + assetsOf(u)), debt: debtOf(u), endedAt: now(), life: u.lives };
    const keep = { name: u.name, token: u.token, createdAt: u.createdAt, grandmaAt: u.grandmaAt, lives: u.lives + 1, lastLife: prev, admin: u.admin, cheats: u.cheats };
    for (const k of Object.keys(u)) delete u[k];
    Object.assign(u, keep);
    withDefaults(u);
    momSay(u, 'newLife');
    addFeed(`♻️ ${me} начинает новую жизнь №${u.lives}. Прошлая закончилась с капиталом ${rub(prev.net)}${prev.debt ? ` и долгом маме ${rub(prev.debt)}` : ''}`, 'refill');
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
    if (game === 'crash') cfg = { blind: config.blind === true || config.blind === 'true' || config.blind === '1' };
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
  on('duel:cashout', ({ id }) => {
    const d = myDuel(me, id, 'crash');
    const s = d.state;
    if (s.cash[me]) throw new Error('Уже выведено');
    const el = now() - s.startAt;
    if (el < 0) throw new Error('Раунд ещё не начался');
    const m = multAt(el);
    if (m >= s.crash) throw new Error('Поздно — краш!');
    s.cash[me] = m;
    const [a, b] = d.players;
    if (s.cash[a] && s.cash[b]) settleDuel(d, { [a]: s.cash[a], [b]: s.cash[b] });
    else broadcastDuels();
    return { mult: m };
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

setInterval(momTick, 2000);
planeBetting();
roulBetting();
save();
server.listen(PORT, () => {
  console.log(`🎰 РофлКазино запущено: http://localhost:${PORT}`);
  console.log(`🕶️  Код читов (не показывай другу): напиши в чате сайта  /читы ${CHEAT_CODE}`);
});
