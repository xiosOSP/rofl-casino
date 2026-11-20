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
const minTxt = (n) => { const ms = n * (S.minuteMs || 60000); return ms >= 60000 ? `${r2(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`; };
const timeHM = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const STAGE = {
  0: { badge: '⏳ в срок', mood: '🤨', moodTxt: 'Ждёт деньги назад' },
  1: { badge: '📞 Мама звонит', mood: '📞', moodTxt: 'Звонит без остановки. Капает пеня 3% в минуту' },
  2: { badge: '😡 Конфискация', mood: '😡', moodTxt: 'Забирает половину прибыли с каждого выигрыша' },
  3: { badge: '🔒 Арест', mood: '🤬', moodTxt: 'Домашний арест: ставки не больше 1 000 ₽' },
};
const STAGE_MIN = { 2: 3, 3: 10 };
function loanStageC(l) {
  const t = sNow();
  if (l.status !== 'active' || t < l.dueAt) return 0;
  const m = (t - l.dueAt) / (S.minuteMs || 60000);
  return m >= STAGE_MIN[3] ? 3 : m >= STAGE_MIN[2] ? 2 : 1;
}
const activeLoansC = () => (S.me ? S.me.loans.filter((l) => l.status === 'active') : []);
const myStage = () => activeLoansC().reduce((s, l) => Math.max(s, loanStageC(l)), 0);
const GAME_LABEL = {
  crash: '📈 Краш 1×1', mines: '💣 Мины', 'mines-duel': '💣 Мины-дуэль', towers: '🗼 Башни', 'towers-duel': '🗼 Башни-дуэль',
  roulette: '🎡 Рулетка', plane: '✈️ Самолётик', cases: '📦 Кейсы', 'cases-battle': '📦 Кейс-батл', dice: '🎲 Кости', coin: '🪙 Монетка',
};
function titlesOf(p) {
  const t = [];
  if (p.stage >= 3) t.push('🔒 Под арестом'); else if (p.stage >= 1) t.push('📞 Должник');
  if (p.trust >= 90) t.push('🥰 Любимчик мамы');
  if (p.net < 0) t.push('🕳️ В минусе');
  if (p.best >= 100) t.push('🚀 Ракетчик');
  if (p.lives > 1) t.push(`♻️ Жизнь №${p.lives}`);
  if (p.assets >= 1e6) t.push('🏢 Рантье');
  return t.join(' ');
}

// ───────────────────────── сборка вкладок ─────────────────────────
let v2Built = false;
function v2Build() {
  v2Built = true;
  $('#tab-mom').innerHTML = `
    <div class="panel mom-top">
      <div class="mom-face" id="momFace">🙂</div>
      <div class="mom-info">
        <h2 style="margin:0">Мама-банк</h2>
        <div id="momMood" class="muted"></div>
        <div class="row"><span>Доверие мамы</span><b id="momTrust"></b></div>
        <div class="progress trust-bar"><div id="momTrustBar"></div></div>
        <div class="row"><span>Долг: <b id="momDebt"></b></span><span>Лимит: <b id="momLimit"></b></span></div>
      </div>
    </div>
    <div class="panel newlife">
      <div><b>♻️ Начать новую жизнь</b> <span class="badge" id="lifeNo"></span>
        <div class="small muted">Баланс снова 10 000 ₽, мама прощает долги, доверие 60, статистика и история с нуля. В рейтинге все увидят номер твоей жизни.</div>
        <div class="small muted" id="lastLife"></div></div>
      <button class="btn red" data-act="newLife">♻️ Начать заново</button>
    </div>
    <div class="mom-grid">
      <div class="panel"><h3>Мои долги</h3><div id="momLoans" class="plans"></div></div>
      <div class="panel"><h3>Взять в долг</h3><div id="momPlans" class="plans"></div>
        <div class="rules" id="momRules" style="margin-top:10px"></div></div>
      <div class="panel"><h3>Подработка</h3><div id="momJobs" class="jobs"></div>
        <div class="rules" style="margin-top:10px">Деньги с подработки мама не забирает. Каждая работа: доверие +1.</div></div>
      <div class="panel"><h3>Бабушка</h3><div id="momGrandma"></div></div>
      <div class="panel"><h3>Сообщения от мамы</h3><div id="momMsgs" class="mom-msgs"></div></div>
      <div class="panel"><h3>Кредитная история</h3><div id="momHistory"></div></div>
    </div>`;

  $('#tab-stats').innerHTML = `
    <div class="panel"><h2>🏆 Рейтинг</h2><div class="table-wrap"><table class="tbl" id="rankTbl"></table></div>
      <div class="rules" style="margin-top:10px">Капитал = баланс − долг маме + имущество (по цене продажи). Именно он решает, кто круче.</div></div>
    <div class="grid-eq">
      <div class="panel"><h3>Моя статистика</h3><div class="table-wrap"><table class="tbl" id="myStats"></table></div><div class="kv" id="myMomStats"></div></div>
      <div class="panel"><h3>Последние ставки</h3><div id="myHistory" class="bets-table" style="max-height:520px"></div></div>
    </div>`;

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
  renderMomAll();
  renderMyStats();
  renderCheats();
}
socket.on('mom', (m) => toast('👩 Мама: ' + m.text, 'mom'));
socket.on('confiscated', ({ amount }) => toast(`😡 Мама забрала ${rub(amount)} из выигрыша в счёт долга`, 'bad'));
socket.on('jobDone', (j) => toast(`${j.emoji} ${j.name} — готово: +${rub(j.pay)}`, 'ok'));

function v2RenderPlayers() {
  const list = S.players;
  $('#players').innerHTML = list.map((p) => `<div class="player"><span class="st ${p.online ? 'on' : ''}"></span>
    <div class="nm">${esc(p.name)}${p.name === me() ? ' <span class="muted">(ты)</span>' : ''}
      <div class="debt ${p.stage ? 'bad' : ''}">${p.debt > 0 ? `долг маме ${rub(p.debt)}${p.stage ? ' ' + STAGE[p.stage].mood : ''}` : 'без долгов'} · 🤝 ${p.trust}</div></div>
    <div style="text-align:right"><div class="bl">${rub(p.balance)}</div><div class="debt">капитал ${rub(p.net)}</div></div></div>`).join('');
  const sel = $('#trTo'), cur = sel.value;
  sel.innerHTML = list.filter((p) => p.name !== me()).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.debt > 0 ? ` (долг ${rub(p.debt)})` : ''}</option>`).join('') || '<option value="">нет игроков</option>';
  if (cur) sel.value = cur;
  renderRank();
}
$('#payForBtn').onclick = async () => {
  const r = await emit('mom:payFor', { to: $('#trTo').value, amount: $('#trAmount').value });
  if (r) { $('#trAmount').value = ''; toast(`🦸 Закрыто ${rub(r.paid)} долга друга`, 'ok'); }
};

// ───────────────────────── мама-банк ─────────────────────────
const sigs = {};
const changed = (k, v) => { const j = JSON.stringify(v); if (sigs[k] === j) return false; sigs[k] = j; return true; };
function renderMomAll() {
  if (!v2Built || !S.me) return;
  renderMomTop(); renderLoans(); renderPlans(); renderJobs(); renderGrandma(); renderMomMsgs(); renderLoanHistory();
}
function renderMomTop() {
  const u = S.me, st = myStage(), debt = u.debt;
  const face = st ? STAGE[st].mood : debt > 0 ? '🤨' : u.trust >= 85 ? '🥰' : '🙂';
  const mood = st ? STAGE[st].moodTxt : debt > 0 ? STAGE[0].moodTxt : u.trust >= 85 ? 'Гордится тобой' : 'Всё спокойно';
  const f = $('#momFace');
  if (f.textContent !== face) f.textContent = face;
  f.classList.toggle('angry', st >= 2);
  $('#momMood').textContent = mood;
  $('#momTrust').textContent = `${u.trust}/100`;
  $('#momTrustBar').style.width = u.trust + '%';
  $('#momDebt').textContent = rub(debt);
  $('#momLimit').textContent = rub(u.limit);
  $('#lifeNo').textContent = `сейчас жизнь №${u.lives}`;
  $('#lastLife').textContent = u.lastLife ? `Прошлая жизнь №${u.lastLife.life} закончилась с капиталом ${rub(u.lastLife.net)}${u.lastLife.debt ? ` (долг маме ${rub(u.lastLife.debt)})` : ''}.` : '';
  $('#momRules').innerHTML = `Срок вышел → <b>📞</b> пеня 3% в минуту и новые займы запрещены.<br>
    Через ${minTxt(3)} → <b>😡</b> мама забирает 50% прибыли с выигрышей.<br>
    Через ${minTxt(10)} → <b>🔒</b> ставки не больше ${rub(S.arrestMax || 1000)}.<br>
    Не больше 3 долгов. Отсрочка — один раз, до дедлайна, +10%.`;
}
function renderLoans() {
  const loans = activeLoansC();
  if (!changed('loans', [loans.map((l) => [l.id, l.owed, l.extended, l.dueAt, loanStageC(l)]), Math.floor(S.me.balance)])) return;
  const el = $('#momLoans');
  const keep = {};
  el.querySelectorAll('input[data-rp]').forEach((i) => { keep[i.dataset.rp] = i.value; });
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rp : null;
  el.innerHTML = loans.length ? loans.map((l) => {
    const st = loanStageC(l);
    const canAll = Math.min(l.owed, S.me.balance);
    return `<div class="loan s${st}">
      <div class="row"><b>${l.emoji} ${esc(l.name)}</b><span class="badge s${st}">${STAGE[st].badge}</span></div>
      <div class="row"><span class="muted">Осталось вернуть</span><b class="owed">${rub(l.owed)}</b></div>
      <div class="muted small">Взято ${rub(l.principal)} под ${Math.round(l.rate * 100)}% · выплачено ${rub(l.paid)}${l.penalty ? ` · пени ${rub(l.penalty)}` : ''}${l.extended ? ' · отсрочка была' : ''}</div>
      <div class="progress" data-bar-from="${l.takenAt}" data-bar-to="${l.dueAt}"><div></div></div>
      <div class="cd" data-due="${l.dueAt}"></div>
      <div class="row acts">
        <button class="btn small green" data-act="repayAll" data-id="${l.id}" ${canAll > 0 ? '' : 'disabled'}>Вернуть ${canAll >= l.owed ? 'всё' : ''} ${rub(canAll)}</button>
        <input type="number" min="1" placeholder="₽" data-rp="${l.id}">
        <button class="btn small" data-act="repayPart" data-id="${l.id}">Частично</button>
        ${!l.extended && st === 0 ? `<button class="btn small" data-act="extend" data-id="${l.id}" title="Сдвинуть срок, долг +10%, доверие −5">⏰ Отсрочка +${minTxt(Math.ceil(l.minutes / 2))}</button>` : ''}
      </div></div>`;
  }).join('') : '<div class="muted">Долгов нет. Мама гордится 🥰</div>';
  el.querySelectorAll('input[data-rp]').forEach((i) => { if (keep[i.dataset.rp]) i.value = keep[i.dataset.rp]; if (focused === i.dataset.rp) i.focus(); });
  updateTimers(true);
}
function renderPlans() {
  const u = S.me, st = myStage(), n = activeLoansC().length;
  if (!changed('plans', [u.trust, st, n, u.debt, u.limit])) return;
  $('#momPlans').innerHTML = S.loanPlans.map((p) => {
    const owe = r2(p.amount * (1 + p.rate));
    let why = '';
    if (st) why = 'сначала верни просроченное';
    else if (n >= 3) why = 'уже 3 долга';
    else if (u.trust < p.minTrust) why = `нужно доверие ${p.minTrust}`;
    else if (u.debt + owe > u.limit) why = 'превышен лимит';
    return `<div class="plan ${why ? 'locked' : ''}">
      <div class="row"><b>${p.emoji} ${p.name}</b><b style="color:var(--gold)">+${rub(p.amount)}</b></div>
      <div class="row small muted"><span>Вернуть ${rub(owe)} (${Math.round(p.rate * 100)}%) за ${minTxt(p.minutes)}</span><span>🤝 от ${p.minTrust}</span></div>
      <button class="btn small ${why ? '' : 'primary'}" data-act="loan" data-plan="${p.id}" ${why ? 'disabled' : ''}>${why ? '🚫 ' + why : 'Попросить у мамы'}</button>
    </div>`;
  }).join('');
}
function renderJobs() {
  const u = S.me, t = sNow();
  const state = Object.values(S.jobs).map((j) => {
    if (u.job && u.job.id === j.id) return [j.id, 'work', Math.ceil((u.job.endsAt - t) / 1000)];
    const cd = (u.jobCd[j.id] || 0) - t;
    if (cd > 0) return [j.id, 'cd', Math.ceil(cd / 1000)];
    return [j.id, u.job ? 'busy' : 'ready'];
  });
  if (!changed('jobs', state)) return;
  $('#momJobs').innerHTML = Object.values(S.jobs).map((j, i) => {
    const [, mode, left] = state[i];
    let btn;
    if (mode === 'work') btn = `<div class="progress" data-bar-from="${u.job.startedAt}" data-bar-to="${u.job.endsAt}"><div></div></div><div class="small muted">Работаешь… ещё ${fmtDur(left * 1000)}</div>`;
    else if (mode === 'cd') btn = `<button class="btn small" disabled>Отдыхаешь: ${fmtDur(left * 1000)}</button>`;
    else if (mode === 'busy') btn = '<button class="btn small" disabled>Сначала закончи текущую</button>';
    else btn = `<button class="btn small primary" data-act="job" data-id="${j.id}">Работать</button>`;
    return `<div class="job"><div class="row"><b>${j.emoji} ${j.name}</b><b style="color:var(--gold)">+${rub(j.pay)}</b></div>
      <div class="small muted">Длится ${fmtDur(j.secs * 1000)} · перерыв ${fmtDur(j.cd * 1000)}</div>${btn}</div>`;
  }).join('');
  updateTimers(true);
}
function renderGrandma() {
  const left = S.me.grandmaAt + S.grandmaCd - sNow();
  const sec = Math.max(0, Math.ceil(left / 1000));
  if (!changed('grandma', sec)) return;
  $('#momGrandma').innerHTML = `<div class="job"><div class="row"><b>👵 Бабушка</b><span class="muted small">не долг!</span></div>
    <div class="small muted">Раз в ${fmtDur(S.grandmaCd)} даёт 1 000–3 000 ₽ на мороженое.</div>
    ${sec > 0 ? `<button class="btn small" disabled>Бабушка спит… ${fmtDur(sec * 1000)}</button>` : '<button class="btn small gold" data-act="grandma">Навестить бабушку</button>'}</div>`;
}
function renderMomMsgs() {
  const list = S.me.mom || [];
  if (!changed('msgs', list.length ? [list.length, list[0].t] : [])) return;
  $('#momMsgs').innerHTML = list.length ? list.map((m) => `<div class="bubble">${esc(m.text)}<span class="tm">${timeHM(m.t)}</span></div>`).join('')
    : '<div class="muted">Мама пока молчит.</div>';
}
function renderLoanHistory() {
  const list = S.me.loans.filter((l) => l.status !== 'active');
  if (!changed('lhist', list.map((l) => l.id))) return;
  $('#momHistory').innerHTML = list.length ? list.map((l) => `<div class="hist-loan">
    <span>${l.emoji} ${esc(l.name)} <span class="muted small">${timeHM(l.takenAt)}</span></span>
    <span>${rub(l.principal)} → ${rub(l.paid)} ${l.forgiven ? '<b class="pos">🕶️ прощён</b>' : l.wasOverdue ? '<b class="neg">⚠️ с просрочкой</b>' : '<b class="pos">✅ вовремя</b>'}</span></div>`).join('')
    : '<div class="muted">Пока пусто.</div>';
}

// таймеры: обратный отсчёт, полоски, плашка долга
let lastTimers = 0;
function updateTimers(force) {
  const t = sNow();
  if (!force && Date.now() - lastTimers < 250) return;
  lastTimers = Date.now();
  if (!S.me || !S.minuteMs) return;
  document.querySelectorAll('[data-due]').forEach((e) => {
    const left = Number(e.dataset.due) - t;
    const txt = left > 0 ? `⏳ Осталось ${fmtDur(left)}` : `🔥 Просрочено на ${fmtDur(-left)}`;
    if (e.textContent !== txt) e.textContent = txt;
    e.classList.toggle('late', left <= 0);
  });
  document.querySelectorAll('[data-bar-from]').forEach((e) => {
    const a = Number(e.dataset.barFrom), b = Number(e.dataset.barTo);
    const p = Math.max(0, Math.min(1, (t - a) / (b - a)));
    e.firstElementChild.style.width = p * 100 + '%';
    e.classList.toggle('bar-late', t >= b && e.closest('.loan'));
  });
  // плашка в шапке
  const loans = activeLoansC();
  const pill = $('#debtPill');
  let txt = '👩 Мама', cls = 'debt-pill';
  if (loans.length) {
    const next = loans.reduce((m, l) => (l.dueAt < m.dueAt ? l : m), loans[0]);
    const left = next.dueAt - t;
    if (left <= 0) { txt = `🔥 Долг ${rub(S.me.debt)} · ${fmtDur(-left)}`; cls += ' bad'; }
    else { txt = `💸 Долг ${rub(S.me.debt)} · ⏳ ${fmtDur(left)}`; cls += left < 2 * S.minuteMs ? ' warn soon' : ' warn'; }
  }
  if (pill.textContent !== txt) pill.textContent = txt;
  if (pill.className !== cls) pill.className = cls;
}
function v2Frame() {
  updateTimers(false);
  updateCheatTags();
  if (S.tab === 'mom' && v2Built && Date.now() - (v2Frame.last || 0) > 500) {
    v2Frame.last = Date.now();
    renderMomTop(); renderLoans(); renderPlans(); renderJobs(); renderGrandma();
  }
}

// ───────────────────────── рейтинг и статистика ─────────────────────────
function renderRank() {
  if (!v2Built) return;
  $('#rankTbl').innerHTML = `<tr><th>#</th><th>Игрок</th><th class="num">Капитал</th><th class="num">Баланс</th><th class="num">Долг маме</th><th class="num">Имущество</th><th class="num">🤝</th><th class="num">Рекорд</th><th>Статус</th></tr>` +
    S.players.map((p, i) => `<tr class="${p.name === me() ? 'me' : ''}"><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td>
      <td><b>${esc(p.name)}</b> ${p.online ? '🟢' : ''}</td><td class="num ${p.net < 0 ? 'neg' : ''}"><b>${rub(p.net)}</b></td>
      <td class="num">${rub(p.balance)}</td><td class="num ${p.debt ? 'neg' : ''}">${p.debt ? rub(p.debt) : '—'}</td><td class="num">${p.assets ? `${rub(p.assets)} <span class="muted small">(${p.props})</span>` : '—'}</td>
      <td class="num">${p.trust}</td><td class="num">${p.best ? '×' + p.best.toFixed(2) : '—'}</td><td>${titlesOf(p)}</td></tr>`).join('');
}
function renderMyStats() {
  if (!v2Built || !S.me.stats) return;
  const st = S.me.stats;
  if (!changed('mystats', [st, S.me.history.length && S.me.history[0].t])) return;
  const rows = Object.entries(st.games).filter(([, g]) => g.played || g.wagered);
  let tw = 0, tr = 0;
  $('#myStats').innerHTML = `<tr><th>Игра</th><th class="num">Игр</th><th class="num">Побед</th><th class="num">Поставлено</th><th class="num">Получено</th><th class="num">Профит</th></tr>` +
    (rows.length ? rows.map(([k, g]) => {
      tw += g.wagered; tr += g.returned;
      const p = r2(g.returned - g.wagered);
      return `<tr><td>${GAME_LABEL[k] || k}</td><td class="num">${g.played}</td><td class="num">${g.won}</td><td class="num">${rub(g.wagered)}</td><td class="num">${rub(g.returned)}</td><td class="num ${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : ''}${rub(p)}</td></tr>`;
    }).join('') + `<tr><td><b>Итого</b></td><td></td><td></td><td class="num"><b>${rub(tw)}</b></td><td class="num"><b>${rub(tr)}</b></td><td class="num ${tr - tw >= 0 ? 'pos' : 'neg'}"><b>${tr - tw >= 0 ? '+' : ''}${rub(tr - tw)}</b></td></tr>`
      : '<tr><td colspan="6" class="muted">Ещё не играл(а)</td></tr>');
  const kv = [['Занято у мамы', rub(st.borrowed)], ['Возвращено маме', rub(st.repaid)], ['Пени набежало', rub(st.penalties)],
    ['Мама конфисковала', rub(st.confiscated)], ['Вернул(а) вовремя / с просрочкой', `${st.onTime} / ${st.late}`], ['Просрочек всего', st.overdue],
    ['Подработок', `${st.jobs} (+${rub(st.jobsEarned)})`], ['От бабушки', rub(st.grandma)], ['Закрыто долгов друзей', rub(st.helped)],
    ['Вложено в имущество', rub(st.propSpent || 0)], ['Доход с имущества', rub(st.propIncome || 0)]];
  $('#myMomStats').innerHTML = kv.map(([k, v]) => `<span class="muted">${k}</span><b>${v}</b>`).join('');
  const h = S.me.history;
  $('#myHistory').innerHTML = h.length ? h.map((x) => {
    const p = r2(x.payout - x.stake);
    return `<div><span><span class="muted small">${timeHM(x.t)}</span> ${GAME_LABEL[x.game] || x.game} · ${rub(x.stake)}</span>
      <span class="${p >= 0 ? 'ok' : 'neg'}">${p >= 0 ? '+' : ''}${rub(p)}${x.taken ? ` <span class="neg small">(мама −${rub(x.taken)})</span>` : ''}</span></div>`;
  }).join('') : '<div class="muted">Ставок пока нет</div>';
}

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
  gomom() { setTab('mom'); },
  async newLife() {
    const u = S.me;
    const msg = `Начать новую жизнь №${u.lives + 1}?\n\n• Баланс станет 10 000 ₽ (сейчас ${rub(u.balance)})\n• Долги маме спишутся (${rub(u.debt)})\n• Доверие мамы — 60, статистика и история — с нуля\n\nВернуть прошлую жизнь будет нельзя.`;
    if (!confirm(msg)) return;
    const r = await emit('life:restart');
    if (r) { toast(`♻️ Добро пожаловать в жизнь №${r.lives}!`, 'ok'); confetti(60); lastHistT = 0; diceHist.length = 0; }
  },
  async loan(b) {
    const r = await emit('mom:loan', { plan: b.dataset.plan });
    if (r) Snd.play('coin');
  },
  async repayAll(b) {
    const r = await emit('mom:repay', { id: Number(b.dataset.id), amount: 'all' });
    if (r) toast(r.closed ? `✅ Долг закрыт! Отдано ${rub(r.paid)}` : `Отдано маме ${rub(r.paid)}`, 'ok');
  },
  async repayPart(b) {
    const inp = document.querySelector(`input[data-rp="${b.dataset.id}"]`);
    const r = await emit('mom:repay', { id: Number(b.dataset.id), amount: inp.value });
    if (r) { inp.value = ''; toast(r.closed ? `✅ Долг закрыт! Отдано ${rub(r.paid)}` : `Отдано маме ${rub(r.paid)}`, 'ok'); }
  },
  extend(b) { if (confirm('Попросить отсрочку? Долг вырастет на 10%, доверие −5.')) emit('mom:extend', { id: Number(b.dataset.id) }); },
  job(b) { emit('job:start', { id: b.dataset.id }); },
  async grandma() {
    const r = await emit('grandma');
    if (r) { toast(`👵 Бабушка дала ${rub(r.amount)} на мороженое!`, 'ok'); confetti(40); }
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
  ['xray', '🩻 Рентген', 'Подсвечивает мины и бомбы красной рамкой: мины и башни, соло и дуэли'],
  ['crashSight', '🔮 Видеть краш', 'Показывает, на каком иксе улетит самолётик и крашнется краш 1×1'],
  ['alwaysWin', '🍀 Всегда везёт', 'Кости всегда в зоне выигрыша, монетка всегда за тебя'],
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
  if (!on) { if (S.tab === 'cheats') setTab('crash'); $('#tab-cheats').innerHTML = ''; sigs.cheats = null; return; }
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
        <div class="row" style="margin-top:8px">
          <button class="btn small" data-act="cheatForgive">🧾 Мама прощает все долги</button>
          <button class="btn small" data-act="cheatTrust">🥰 Доверие мамы 100</button>
          <button class="btn small" data-act="cheatCd">⏩ Сбросить подработку и бабушку</button></div></div>
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
  const pw = $('#pCv') && $('#pCv').parentElement, cw = $('#crCv') && $('#crCv').parentElement;
  if (!S.me || !S.me.admin || !S.me.cheats.crashSight) { cheatTag(pw, 'pCheat', ''); cheatTag(cw, 'crCheat', ''); return; }
  const p = S.plane;
  cheatTag(pw, 'pCheat', p && p.phase === 'flying' && S.cheatPlane && S.cheatPlane.round === p.round ? `🔮 улетит на ×${S.cheatPlane.crash.toFixed(2)}` : '');
  const d = viewDuel('crash');
  cheatTag(cw, 'crCheat', d && d.state && d.state.sight ? `🔮 краш на ×${d.state.sight.toFixed(2)}` : '');
}
Object.assign(ACT, {
  cheatMoney(b) { emit('cheat:money', { amount: $('#chAmount').value, mode: b.dataset.mode }).then((r) => r && toast('💰 Готово', 'ok')); },
  cheatForgive() { emit('cheat:forgive').then((r) => r && toast('🧾 Долги прощены', 'ok')); },
  cheatTrust() { emit('cheat:trust').then((r) => r && toast('🥰 Доверие 100', 'ok')); },
  cheatCd() { emit('cheat:cooldowns').then((r) => r && toast('⏩ Перезарядки сброшены', 'ok')); },
  cheatRoul() { emit('cheat:roulette', { n: Number($('#chRoul').value) }); },
  cheatRoulClear() { emit('cheat:roulette', { n: null }); },
});
