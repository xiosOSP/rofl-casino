'use strict';
/* РофлКазино v2: мама-банк, рейтинг, кости, монетка, звуки, конфетти */

// ───────────────────────── звук ─────────────────────────
const Snd = {
  on: ls.get('rc_sound') !== '0',
  ctx: null,
  tone(f, at, dur, type = 'sine', vol = 0.07) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    const t0 = c.currentTime + at;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  play(kind) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const seq = {
        win: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.25]],
        lose: [[320, 0, 0.18, 'sawtooth', 0.04], [210, 0.16, 0.3, 'sawtooth', 0.04]],
        ring: [[880, 0, 0.12], [660, 0.14, 0.12], [880, 0.28, 0.12], [660, 0.42, 0.14]],
        coin: [[988, 0, 0.08], [1319, 0.07, 0.2]],
        click: [[700, 0, 0.04, 'sine', 0.03]],
        big: [[523, 0, 0.1], [659, 0.08, 0.1], [784, 0.16, 0.1], [1047, 0.24, 0.35]],
      }[kind];
      for (const [f, at, d, ty, v] of seq || []) this.tone(f, at, d, ty, v);
    } catch { /* без звука */ }
  },
};
window.Snd = Snd;
function renderSoundBtn() { $('#soundBtn').textContent = Snd.on ? '🔊' : '🔇'; }
$('#soundBtn').onclick = () => { Snd.on = !Snd.on; ls.set('rc_sound', Snd.on ? '1' : '0'); renderSoundBtn(); Snd.play('click'); };
renderSoundBtn();

// ───────────────────────── конфетти ─────────────────────────
function confetti(n = 90) {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#facc15', '#ec4899', '#7c5cff', '#22c55e', '#38bdf8', '#f97316'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.6 + 's';
    p.style.animationDuration = 1.8 + Math.random() * 1.4 + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3800);
}

// ───────────────────────── помощники ─────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
}
const timeHM = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const GAME_LABEL = {
  crash: '📈 Краш 1×1', mines: '💣 Мины', 'mines-duel': '💣 Мины-дуэль', towers: '🗼 Башни', 'towers-duel': '🗼 Башни-дуэль',
  roulette: '🎡 Рулетка', plane: '✈️ Самолётик', cases: '📦 Кейсы', 'cases-battle': '📦 Кейс-батл', dice: '🎲 Кости', coin: '🪙 Монетка',
  football: '⚽ Футбол',
};
function titlesOf(p) {
  const t = [];
  if (p.balance >= 1e6) t.push('💎 Миллионер');
  if (p.best >= 100) t.push('🚀 Ракетчик');
  if (p.bigWin >= 100000) t.push('🎰 Хайроллер');
  if (p.balance < 100) t.push('🕳️ На нуле');
  if (p.lives > 1) t.push(`♻️ Жизнь №${p.lives}`);
  return t.join(' ');
}

// ───────────────────────── сборка вкладок ─────────────────────────
let v2Built = false;
function v2Build() {
  v2Built = true;
  $('#tab-dice').innerHTML = `
    <div class="grid2">
      <div class="panel controls"><h2>🎲 Кости</h2>${betField('dBet')}
        <div class="field"><label>Шанс выигрыша: <b id="dChanceTxt"></b></label><input type="range" id="dChance" min="1" max="95" value="50"></div>
        <div class="seg" id="dDir"><button data-act="ddir" data-k="under">⬇️ Меньше</button><button data-act="ddir" data-k="over">⬆️ Больше</button></div>
        <div id="dInfo" class="rules"></div>
        <button class="btn huge primary" id="dBtn" data-act="droll">Бросить</button>
      </div>
      <div class="panel dice-stage">
        <div class="dice-big" id="dResult">🎲</div>
        <div class="dice-track"><div class="dice-win" id="dWinZone"></div><div class="dice-marker hidden" id="dMarker"></div></div>
        <div class="row dice-scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
        <div class="hist" id="dHist"></div>
      </div>
    </div>
    <div class="panel"><h2>🪙 Монетка 1×1</h2><div class="rules">Создатель выбирает сторону. Монетку подбрасывают: угадал создатель — банк его, нет — банк соперника. Чистые 50/50.</div></div>
    <div class="panel hidden" id="arena-coin"></div>${lobbyHTML('coin')}`;

  // фильтр кейсов по цене
  $('#cGrid').insertAdjacentHTML('beforebegin', `<div class="seg" id="cFilter" style="margin-bottom:12px">
    <button data-act="cfilter" data-k="all" class="active">Все</button><button data-act="cfilter" data-k="cheap">До 500 ₽</button>
    <button data-act="cfilter" data-k="mid">500–2 500 ₽</button><button data-act="cfilter" data-k="rich">Дорогие</button></div>`);
  // кейсы — по цене
  $('#cGrid').innerHTML = S.cases.map((c) => `
    <div class="case-card" data-act="selcase" data-id="${c.id}"><div class="ce">${c.emoji}</div><div class="cn">${c.name}</div><div class="cp">${rub(c.price)}</div></div>`).join('');
  renderCaseOpener();
  renderDice();
}

// ───────────────────────── обновления от сервера ─────────────────────────
let lastHistT = 0;
function v2OnMe() {
  if (!S.me || !S.built) return;
  if (!v2Built) v2Build();
  const h = S.me.history && S.me.history[0];
  if (h && h.t !== lastHistT) {
    if (lastHistT && h.stake > 0 && h.payout / h.stake >= 5) { confetti(); Snd.play('big'); }
    lastHistT = h.t;
  }
  renderLifeBtn();
  refreshProfile();
  renderCheats();
}
function v2RenderPlayers() {
  const list = S.players;
  const on = list.filter((p) => p.online).length;
  $('#playersHead').textContent = `${list.length} · онлайн ${on}`;
  $('#players').innerHTML = list.map((p, i) => `<div class="player" data-act="profile" data-name="${esc(p.name)}">
    <span class="place p${i + 1}">${i + 1}</span><span class="st ${p.online ? 'on' : ''}"></span>
    <div class="nm">${esc(p.name)}${p.name === me() ? ' <span class="muted">(ты)</span>' : ''}
      <div class="debt">${p.best ? `рекорд ×${p.best.toFixed(2)}` : 'ещё без рекордов'}${p.lives > 1 ? ` · жизнь №${p.lives}` : ''}</div></div>
    <div class="bl">${rub(p.balance)}</div></div>`).join('');
  const sel = $('#trTo'), cur = sel.value;
  sel.innerHTML = list.filter((p) => p.name !== me()).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('') || '<option value="">нет игроков</option>';
  if (cur) sel.value = cur;
  refreshProfile();
}
// кнопка «новая жизнь» в шапке — когда деньги почти кончились
function renderLifeBtn() {
  const b = $('#lifeBtn');
  if (b) b.classList.toggle('hidden', !(S.me && S.me.balance < 100));
}

const sigs = {};
const changed = (k, v) => { const j = JSON.stringify(v); if (sigs[k] === j) return false; sigs[k] = j; return true; };
function v2Frame() { updateCheatTags(); }

// ───────────────────────── профиль игрока ─────────────────────────
S.profileName = null;
let profileTimer = null;
async function openProfile(name) {
  S.profileName = name || me();
  $('#profileModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#profileBody').innerHTML = '<div class="muted" style="padding:40px;text-align:center">Загружаю…</div>';
  await loadProfile();
}
function closeProfile() {
  S.profileName = null;
  $('#profileModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}
function refreshProfile() { // обновить открытый профиль не чаще раза в 1.5 с
  if (!S.profileName || profileTimer) return;
  profileTimer = setTimeout(() => { profileTimer = null; if (S.profileName) loadProfile(); }, 1500);
}
async function loadProfile() {
  const name = S.profileName;
  const r = await emitRaw('profile:get', { name });
  if (S.profileName !== name) return;
  if (r.error) { $('#profileBody').innerHTML = `<div class="err" style="padding:30px">${esc(r.error)}</div>`; return; }
  renderProfile(r.profile);
}
function renderProfile(p) {
  const mine = p.name === me();
  const st = p.stats || {};
  const games = Object.entries(st.games || {}).filter(([, g]) => g.played || g.wagered);
  let tw = 0, tr = 0, played = 0, won = 0;
  const rows = games.map(([k, g]) => {
    tw += g.wagered; tr += g.returned; played += g.played; won += g.won;
    const pr = r2(g.returned - g.wagered);
    return `<tr><td>${GAME_LABEL[k] || k}</td><td class="num">${g.played}</td><td class="num">${g.won}</td><td class="num">${rub(g.wagered)}</td><td class="num ${pr >= 0 ? 'pos' : 'neg'}">${pr >= 0 ? '+' : ''}${rub(pr)}</td></tr>`;
  }).join('');
  const profit = r2(tr - tw);
  const fav = games.slice().sort((a, b) => b[1].played - a[1].played)[0];
  const tiles = [
    ['💵 Баланс', rub(p.balance), ''], ['🚀 Рекорд', p.best ? '×' + p.best.toFixed(2) : '—', ''],
    ['🏆 Крупнейший выигрыш', p.bigWin ? '+' + rub(p.bigWin) : '—', p.bigWin ? 'pos' : ''], ['🎯 Любимая игра', fav ? GAME_LABEL[fav[0]] || fav[0] : '—', ''],
    ['🎮 Игр', String(played), ''], ['✅ Побед', played ? `${won} (${Math.round((won / played) * 100)}%)` : '0', ''],
    ['💸 Поставлено', rub(tw), ''], ['📈 Профит в играх', `${profit >= 0 ? '+' : ''}${rub(profit)}`, profit >= 0 ? 'pos' : 'neg'],
  ];
  const hist = (p.history || []).map((x) => {
    const pr = r2(x.payout - x.stake);
    return `<div><span><span class="muted small">${timeHM(x.t)}</span> ${GAME_LABEL[x.game] || x.game} · ${rub(x.stake)}</span>
      <span class="${pr >= 0 ? 'ok' : 'neg'}">${pr >= 0 ? '+' : ''}${rub(pr)}${x.payout > x.stake ? ` <span class="muted small">×${(x.payout / x.stake).toFixed(2)}</span>` : ''}</span></div>`;
  }).join('');
  const medal = ['🥇', '🥈', '🥉'][p.place - 1] || `#${p.place}`;
  $('#profileBody').innerHTML = `
    <div class="prof-head">
      <div class="avatar">${esc(p.name[0].toUpperCase())}</div>
      <div style="min-width:0">
        <h2 style="margin:0">${esc(p.name)} ${p.online ? '<span class="st on" title="онлайн"></span>' : ''}</h2>
        <div class="muted small">${medal} место из ${p.total} по балансу · жизнь №${p.lives}</div>
        <div class="titles">${titlesOf(p) || '<span class="muted small">без титулов</span>'}</div>
      </div>
    </div>
    <div class="tiles">${tiles.map(([k, val, c]) => `<div class="tile"><span class="muted small">${k}</span><b class="${c}">${val}</b></div>`).join('')}</div>
    ${mine ? `<div class="newlife prof-acts"><div><b>♻️ Начать новую жизнь</b>
        <div class="small muted">Баланс снова 10 000 ₽, статистика и история — с нуля. Все увидят номер твоей жизни.</div></div>
        <button class="btn red" data-act="newLife">♻️ Начать заново</button></div>`
    : `<div class="row prof-acts"><input id="profAmount" type="number" min="1" placeholder="Сумма, ₽">
      <button class="btn small" data-act="profTransfer">🤝 Перевести</button></div>`}
    <h3>Статистика по играм</h3>
    <div class="table-wrap"><table class="tbl"><tr><th>Игра</th><th class="num">Игр</th><th class="num">Побед</th><th class="num">Поставлено</th><th class="num">Профит</th></tr>
      ${rows || '<tr><td colspan="5" class="muted">Ещё не играл(а)</td></tr>'}</table></div>
    ${p.lastLife ? `<div class="rules" style="margin-top:12px">♻️ Прошлая жизнь №${p.lastLife.life} закончилась с балансом ${rub(p.lastLife.net)}.</div>` : ''}
    <h3>Последние ставки</h3><div class="bets-table">${hist || '<div class="muted">Ставок пока нет</div>'}</div>`;
}
$('#profileModal').addEventListener('click', (e) => { if (e.target.id === 'profileModal') closeProfile(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.profileName) closeProfile(); });
Object.assign(ACT, {
  profile(b) { openProfile(b.dataset.name || me()); },
  closeProfile() { closeProfile(); },
  async profTransfer() {
    const r = await emit('transfer', { to: S.profileName, amount: $('#profAmount').value });
    if (r) { toast('🤝 Перевод отправлен', 'ok'); loadProfile(); }
  },
});

// ───────────────────────── кости ─────────────────────────
S.diceDir = 'under';
const diceHist = [];
function renderDice() {
  const ch = Number($('#dChance').value);
  const mult = Math.floor((97 / ch) * 100) / 100;
  $('#dChanceTxt').textContent = ch + '%';
  document.querySelectorAll('#dDir button').forEach((b) => b.classList.toggle('active', b.dataset.k === S.diceDir));
  const z = $('#dWinZone');
  z.style.left = S.diceDir === 'under' ? '0%' : 100 - ch + '%';
  z.style.width = ch + '%';
  const bet = Number($('#dBet').value) || 0;
  $('#dInfo').innerHTML = `Выигрыш, если выпадет <b>${S.diceDir === 'under' ? `меньше ${ch}` : `${100 - ch} или больше`}</b><br>
    Множитель: <b>×${mult.toFixed(2)}</b> · Выплата: <b>${rub(bet * mult)}</b>`;
}
document.addEventListener('input', (e) => { if (e.target.id === 'dChance' || e.target.id === 'dBet') renderDice(); });
let diceBusy = false;

// ───────────────────────── монетка (арена) ─────────────────────────
const sideLbl = (s) => (s === 'tails' ? '🪙 Решка' : '🦅 Орёл');
ARENA.coin = (d, el) => {
  if (el.dataset.id !== String(d.id)) {
    el.dataset.id = d.id;
    el.innerHTML = `<div class="co-head"></div><div class="co-vs"></div>
      <div class="coin-wrap"><div class="coin" id="coinEl">🪙</div></div><div class="co-banner"></div>`;
    el.dataset.spun = '';
  }
  $('.co-head', el).innerHTML = arenaHead(d);
  const other = d.config.side === 'tails' ? 'heads' : 'tails';
  $('.co-vs', el).innerHTML = vsHTML(d, (n) => ({ value: sideLbl(n === d.creator ? d.config.side : other), sub: n === d.creator ? 'создатель' : 'соперник' }));
  const coin = $('#coinEl', el);
  const face = (f) => (f === 'tails' ? '🪙' : '🦅');
  if (d.status === 'done') {
    coin.classList.remove('spin'); coin.textContent = face(d.state.flip);
    $('.co-banner', el).innerHTML = `<div class="banner">Выпало: ${sideLbl(d.state.flip)}</div>` + bannerHTML(d);
  } else if (d.state && !el.dataset.spun) {
    el.dataset.spun = '1';
    $('.co-banner', el).innerHTML = '';
    const left = Math.max(300, d.state.startAt + 3200 - sNow());
    coin.style.animationDuration = left + 'ms';
    coin.classList.add('spin');
    Snd.play('coin');
    setTimeout(() => { coin.classList.remove('spin'); coin.textContent = face(d.state.flip); }, left);
  } else if (!d.state) {
    $('.co-banner', el).innerHTML = '<div class="muted" style="text-align:center">Ждём соперника…</div>';
  }
};

// ───────────────────────── действия ─────────────────────────
Object.assign(ACT, {
  async newLife() {
    const u = S.me;
    const msg = `Начать новую жизнь №${u.lives + 1}?\n\n• Баланс станет 10 000 ₽ (сейчас ${rub(u.balance)})\n• Статистика и история — с нуля\n\nВернуть прошлую жизнь будет нельзя.`;
    if (!confirm(msg)) return;
    const r = await emit('life:restart');
    if (r) { toast(`♻️ Добро пожаловать в жизнь №${r.lives}!`, 'ok'); confetti(60); lastHistT = 0; diceHist.length = 0; if (S.profileName) loadProfile(); }
  },
  ddir(b) { S.diceDir = b.dataset.k; renderDice(); },
  async droll() {
    if (diceBusy) return;
    diceBusy = true; $('#dBtn').disabled = true;
    const r = await emit('dice:roll', { bet: $('#dBet').value, chance: $('#dChance').value, dir: S.diceDir });
    if (!r) { diceBusy = false; $('#dBtn').disabled = false; return; }
    const mk = $('#dMarker'), res = $('#dResult');
    mk.classList.remove('hidden');
    mk.style.left = r.roll + '%';
    mk.textContent = r.roll.toFixed(2);
    let k = 0;
    const iv = setInterval(() => { res.textContent = (Math.random() * 100).toFixed(2); res.className = 'dice-big'; if (++k > 8) clearInterval(iv); }, 50);
    setTimeout(() => {
      clearInterval(iv);
      res.textContent = r.roll.toFixed(2);
      res.className = 'dice-big ' + (r.win ? 'pos' : 'neg');
      mk.classList.toggle('win', r.win);
      if (r.win) toast(`🎲 ${r.roll.toFixed(2)} — победа! +${rub(r.payout)}`, 'ok'); else Snd.play('lose');
      diceHist.unshift(r); diceHist.length = Math.min(diceHist.length, 14);
      $('#dHist').innerHTML = diceHist.map((x) => `<span class="${x.win ? 'mid' : 'lo'}">${x.roll.toFixed(2)}</span>`).join('');
      diceBusy = false; $('#dBtn').disabled = false;
    }, 500);
  },
  cfilter(b) {
    document.querySelectorAll('#cFilter button').forEach((x) => x.classList.toggle('active', x === b));
    const k = b.dataset.k;
    document.querySelectorAll('#cGrid .case-card').forEach((card) => {
      const c = S.cases.find((x) => x.id === card.dataset.id);
      const ok = k === 'all' || (k === 'cheap' && c.price < 500) || (k === 'mid' && c.price >= 500 && c.price <= 2500) || (k === 'rich' && c.price > 2500);
      card.classList.toggle('hidden', !ok);
    });
  },
});

// пересчитать выплату в костях после кнопок ½ / ×2 / Всё
const _betq = ACT.betq;
ACT.betq = (b) => { _betq(b); if (b.dataset.t === 'dBet') renderDice(); };

// ───────────────────────── 🕶️ читы (видны только админу) ─────────────────────────
// Включаются командой в чате: /читы КОД (код печатается в консоли сервера). Выключить: /читы выкл
S.cheatPlane = null;
socket.on('cheatInfo', (d) => { if (d.plane) S.cheatPlane = d.plane; });
const CHEAT_TOGGLES = [
  ['xray', '🩻 Рентген', 'Подсвечивает мины, бомбы и куда прыгнет вратарь: мины, башни, футбол'],
  ['crashSight', '🔮 Видеть краш', 'Показывает, на каком иксе улетит самолётик'],
  ['alwaysWin', '🍀 Всегда везёт', 'Кости всегда в зоне выигрыша, монетка за тебя, вратарь не угадывает'],
  ['topDrop', '💎 Топ-дроп', 'Из кейсов и в кейс-батле всегда выпадает самый дорогой предмет'],
];
function ensureCheatUI() {
  if (!$('#cheatBtn')) {
    $('#soundBtn').insertAdjacentHTML('beforebegin', '<button class="btn small icon hidden" id="cheatBtn" title="Читы">🕶️</button>');
    $('#cheatBtn').onclick = () => setTab('cheats');
  }
  if (!$('#tab-cheats')) $('#main').insertAdjacentHTML('beforeend', '<section class="tab" id="tab-cheats"></section>');
}
function renderCheats() {
  ensureCheatUI();
  const on = !!(S.me && S.me.admin);
  $('#cheatBtn').classList.toggle('hidden', !on);
  if (!on) { if (S.tab === 'cheats') setTab('roulette'); $('#tab-cheats').innerHTML = ''; sigs.cheats = null; return; }
  const c = S.me.cheats || {};
  if (!changed('cheats', c)) return;
  $('#tab-cheats').innerHTML = `
    <div class="panel cheat-panel"><h2>🕶️ Читы</h2>
      <div class="rules">Видно только тебе. Действия читов не пишутся в ленту. Выключить: напиши в чате <b>/читы выкл</b>.</div></div>
    <div class="mom-grid">
      <div class="panel"><h3>💰 Деньги</h3>
        <div class="row"><input id="chAmount" type="number" placeholder="Сумма, ₽" value="100000">
          <button class="btn small green" data-act="cheatMoney" data-mode="add">+ Добавить</button>
          <button class="btn small" data-act="cheatMoney" data-mode="set">= Сделать баланс</button></div>
</div></div>
      <div class="panel"><h3>🎯 Подкрутка</h3><div class="plans">${CHEAT_TOGGLES.map(([k, n, d]) => `
        <label class="cheat-row"><input type="checkbox" data-cheat="${k}" ${c[k] ? 'checked' : ''}><span><b>${n}</b><br><span class="small muted">${d}</span></span></label>`).join('')}
      </div></div>
      <div class="panel"><h3>🎡 Рулетка: следующее число</h3>
        <div class="row"><select id="chRoul">${range(0, 36).map((n) => `<option value="${n}">${n} ${colorOf(n) === 'red' ? '🔴' : colorOf(n) === 'black' ? '⚫' : '🟢'}</option>`).join('')}</select>
          <button class="btn small primary" data-act="cheatRoul">Подкрутить</button>
          <button class="btn small" data-act="cheatRoulClear">Сбросить</button></div>
        <div class="small muted" style="margin-top:8px">${Number.isInteger(c.rouletteNext) ? `В следующем раунде выпадет <b>${c.rouletteNext}</b> — ставь заранее.` : 'Сейчас рулетка честная.'}</div></div>
    </div>`;
}
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.cheat;
  if (k) emit('cheat:toggle', { key: k, on: e.target.checked });
});
function cheatTag(wrap, id, text) {
  if (!wrap) return;
  let el = document.getElementById(id);
  if (!text) { if (el) el.remove(); return; }
  if (!el) { wrap.insertAdjacentHTML('beforeend', `<div class="cheat-tag" id="${id}"></div>`); el = document.getElementById(id); }
  if (el.textContent !== text) el.textContent = text;
}
function updateCheatTags() {
  const pw = $('#pCv') && $('#pCv').parentElement;
  if (!S.me || !S.me.admin || !S.me.cheats.crashSight) { cheatTag(pw, 'pCheat', ''); return; }
  const p = S.plane;
  cheatTag(pw, 'pCheat', p && p.phase === 'flying' && S.cheatPlane && S.cheatPlane.round === p.round ? `🔮 улетит на ×${S.cheatPlane.crash.toFixed(2)}` : '');
}
Object.assign(ACT, {
  cheatMoney(b) { emit('cheat:money', { amount: $('#chAmount').value, mode: b.dataset.mode }).then((r) => r && toast('💰 Готово', 'ok')); },
  cheatRoul() { emit('cheat:roulette', { n: Number($('#chRoul').value) }); },
  cheatRoulClear() { emit('cheat:roulette', { n: null }); },
});
