'use strict';
/* РофлКазино: ⚽ футбол (серия пенальти) и 🏆 самые большие выигрыши */

// ───────────────────────── футбол ─────────────────────────
S.fbDiffSel = 'medium';
S.fbLast = null; // последний удар: {zone, covered, goal}
const FB_ZONE_NAMES = ['↖ левый верх', '⬆ центр верх', '↗ правый верх', '↙ левый низ', '⬇ центр низ', '↘ правый низ'];
const fbMultC = (diff, n) => {
  if (n <= 0) return 1;
  const p = (6 - S.fbDiff[diff].keeper) / 6;
  return Math.floor((0.97 / Math.pow(p, n)) * 100) / 100;
};
let fbBusy = false;

function fbBuild() {
  $('#tab-football').innerHTML = `
    <div class="grid2">
      <div class="panel controls"><h2>⚽ Футбол</h2>${betField('fBet')}
        <div class="field"><label>Вратарь</label><div class="seg" id="fDiff">${Object.entries(S.fbDiff).map(([k, d]) =>
          `<button data-act="fdiff" data-k="${k}">${d.label}<br><span class="small muted">${d.keeper} из 6</span></button>`).join('')}</div></div>
        <div id="fInfo" class="rules"></div>
        <button class="btn huge primary" id="fBtn" data-act="fstart">Начать серию</button>
        <div class="rules">Выбери, куда бить. Вратарь закрывает часть ворот — угадает зону, будет сейв и ставка сгорит.
          Каждый гол поднимает коэффициент, забирай выигрыш когда захочешь. Максимум ${S.fbKicks} ударов.</div>
      </div>
      <div class="panel pitch-panel">
        <div class="fb-steps" id="fSteps"></div>
        <div class="pitch">
          <div class="goal"><div class="net"></div><div class="goal-grid" id="fGoal"></div></div>
          <div class="fb-msg" id="fMsg"></div>
          <div class="ball" id="fBall">⚽</div>
          <div class="spot"></div>
        </div>
      </div>
    </div>`;
}
function fbRender() {
  if (!S.fbDiff || !S.built) return;
  if (!$('#fGoal')) fbBuild();
  const s = S.football, L = S.fbLast;
  const diff = s ? s.diff : S.fbDiffSel;
  document.querySelectorAll('#fDiff button').forEach((b) => { b.classList.toggle('active', b.dataset.k === diff); b.disabled = !!s; });
  $('#fBet').disabled = !!s;
  // шаги серии
  const goals = s ? s.goals : 0;
  $('#fSteps').innerHTML = Array.from({ length: S.fbKicks }, (_, i) => {
    const n = i + 1;
    const cls = n <= goals ? 'done' : s && n === goals + 1 ? 'cur' : '';
    return `<div class="fb-step ${cls}"><span>${n <= goals ? '⚽' : n}</span><b>×${fbMultC(diff, n).toFixed(2)}</b></div>`;
  }).join('');
  // ворота: 6 зон
  const xray = new Set((s && s.xray) || []);
  $('#fGoal').innerHTML = Array.from({ length: 6 }, (_, z) => {
    let cls = '', ch = '';
    if (L && !fbBusy) {
      if (L.covered.includes(z)) { cls = 'keeper'; ch = '🧤'; }
      if (L.zone === z) { cls += L.goal ? ' goal-hit' : ' saved'; ch = L.goal ? '⚽' : '🧤'; }
    }
    if (s && xray.has(z)) cls += ' xr';
    const can = s && !fbBusy;
    return `<button class="zone ${cls}" ${can ? `data-act="fkick" data-z="${z}"` : 'disabled'} title="${FB_ZONE_NAMES[z]}">${ch}</button>`;
  }).join('');
  // инфо и кнопка
  const btn = $('#fBtn');
  if (s) {
    const win = r2(s.bet * s.mult);
    $('#fInfo').innerHTML = `Голов: <b>${s.goals}/${S.fbKicks}</b> · Коэффициент: <b>×${s.mult.toFixed(2)}</b><br>Следующий гол: <b>×${s.next.toFixed(2)}</b>`;
    btn.dataset.act = 'fcash'; btn.className = 'btn huge green'; btn.disabled = !s.goals || fbBusy;
    btn.textContent = s.goals ? `Забрать ${rub(win)}` : 'Бей по воротам!';
  } else {
    const k = S.fbDiff[diff].keeper;
    $('#fInfo').innerHTML = `Шанс гола: <b>${Math.round(((6 - k) / 6) * 100)}%</b> за удар<br>Первый гол: <b>×${fbMultC(diff, 1).toFixed(2)}</b> · Все ${S.fbKicks}: <b>×${fbMultC(diff, S.fbKicks).toFixed(2)}</b>`;
    btn.dataset.act = 'fstart'; btn.className = 'btn huge primary'; btn.disabled = fbBusy; btn.textContent = 'Начать серию';
  }
}
function fbShowMsg(text, cls) {
  const m = $('#fMsg');
  m.textContent = text; m.className = 'fb-msg show ' + cls;
  setTimeout(() => { m.className = 'fb-msg'; }, 1100);
}
function fbShoot(zone) { // мяч летит в выбранную зону
  const ball = $('#fBall'), cell = $('#fGoal').children[zone];
  fbResetBall(); void ball.offsetWidth;
  const br = ball.getBoundingClientRect(), cr = cell.getBoundingClientRect();
  ball.style.transition = 'transform .45s cubic-bezier(.2,.8,.3,1)';
  ball.style.transform = `translate(${cr.left + cr.width / 2 - (br.left + br.width / 2)}px, ${cr.top + cr.height / 2 - (br.top + br.height / 2)}px) scale(.6) rotate(540deg)`;
}
function fbResetBall() {
  const ball = $('#fBall');
  ball.style.transition = 'none'; ball.style.transform = 'none';
}
Object.assign(ACT, {
  fdiff(b) { if (!S.football) { S.fbDiffSel = b.dataset.k; S.fbLast = null; fbRender(); } },
  async fstart() {
    const r = await emit('football:start', { bet: $('#fBet').value, diff: S.fbDiffSel });
    if (r) { S.football = r.state; S.fbLast = null; fbResetBall(); fbRender(); }
  },
  async fkick(b) {
    if (fbBusy) return;
    const zone = Number(b.dataset.z);
    fbBusy = true; fbRender();
    const r = await emit('football:kick', { zone });
    if (!r) { fbBusy = false; fbRender(); return; }
    fbShoot(zone);
    Snd.play('click');
    await new Promise((res) => setTimeout(res, 480));
    fbBusy = false;
    S.fbLast = { zone, covered: r.covered, goal: !!r.goal };
    if (r.saved) {
      S.football = null;
      fbShowMsg('СЕЙВ! 🧤', 'bad');
      toast('🧤 Вратарь взял! Ставка сгорела', 'bad');
    } else if (r.cashout) {
      S.football = null;
      fbShowMsg('ГОЛ! ⚽', 'good');
      toast(`⚽ Все ${S.fbKicks} голов! ×${r.mult} → +${rub(r.win)}`, 'ok');
    } else {
      S.football = r.state;
      fbShowMsg('ГОЛ! ⚽', 'good');
      Snd.play('coin');
    }
    fbRender();
    setTimeout(() => { if (!fbBusy) fbResetBall(); }, 900);
  },
  async fcash() {
    const r = await emit('football:cashout');
    if (r) { S.football = null; toast(`⚽ Вывод ×${r.mult} → +${rub(r.win)}`, 'ok'); fbResetBall(); fbRender(); }
  },
});
document.addEventListener('input', (e) => { if (e.target.id === 'fBet' && !S.football) fbRender(); });

// ───────────────────────── самые большие выигрыши ─────────────────────────
S.twMode = 'amount';
function renderTopWins() {
  const box = $('#topWins');
  if (!box || !S.topWins) return;
  document.querySelectorAll('#twSeg button').forEach((b) => b.classList.toggle('active', b.dataset.k === S.twMode));
  const list = S.topWins[S.twMode] || [];
  const dt = (t) => { const d = new Date(t); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${timeHM(t)}`; };
  box.innerHTML = list.length ? list.map((w, i) => `<div class="tw ${w.name === me() ? 'mine' : ''}">
      <span class="tw-n p${i + 1}">${i + 1}</span>
      <div class="tw-main">${nick(w.name)} <span class="small muted">${GAME_LABEL[w.game] || w.game}</span>
        <div class="small muted">ставка ${rub(w.stake)} · ${dt(w.t)}</div></div>
      <div class="tw-r">${S.twMode === 'mult'
        ? `<b class="tw-x">×${w.mult.toFixed(2)}</b><span class="small pos">+${rub(w.profit)}</span>`
        : `<b class="pos">+${rub(w.profit)}</b><span class="small muted">×${w.mult.toFixed(2)}</span>`}</div>
    </div>`).join('') : '<div class="muted">Пока никто ничего не выиграл. Будь первым!</div>';
}
socket.on('topWins', (t) => {
  const prevTop = S.topWins && S.topWins.amount[0];
  S.topWins = t;
  renderTopWins();
  const top = t.amount[0];
  if (top && (!prevTop || top.t !== prevTop.t) && prevTop) toast(`🏆 Новый рекорд: ${top.name} +${rub(top.profit)} (${GAME_LABEL[top.game] || top.game})`, 'ok');
});
Object.assign(ACT, { twmode(b) { S.twMode = b.dataset.k; renderTopWins(); } });

// хуки в общий цикл
const _v2OnMeV3 = v2OnMe;
v2OnMe = function () { _v2OnMeV3(); fbRender(); renderTopWins(); };
