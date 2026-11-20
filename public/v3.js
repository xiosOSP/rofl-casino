'use strict';
/* РофлКазино: имущество — квартиры и бизнес */

S.estateKind = 'flat';
CHEAT_TOGGLES.push(['propBoost', '🏢 Доход ×3', 'Квартиры и бизнесы приносят в три раза больше']);
const estDef = (p) => S.propsCatalog[p.type];
const estLevelMult = (def, lvl) => 1 + (def.kind === 'flat' ? 0.25 : 0.5) * (lvl - 1);
const stars = (risk) => (risk <= 0 ? '★★★★★' : risk <= 0.03 ? '★★★★☆' : risk <= 0.06 ? '★★★☆☆' : risk <= 0.12 ? '★★☆☆☆' : '★☆☆☆☆');
function liveCash(p) {
  const t = Math.min(sNow(), p.state === 'rented' ? p.rentUntil : Infinity);
  return Math.min(p.cap, p.cash + (p.rate * Math.max(0, t - p.lastTick)) / (S.minuteMs || 60000));
}

function estateBuild() {
  $('#tab-estate').innerHTML = `
    <div class="panel estate-top">
      <div><h2 style="margin:0">🏢 Имущество</h2><div class="muted small">Квартиры и бизнесы приносят деньги, даже когда ты офлайн.</div></div>
      <div class="estate-sum">
        <div><span class="muted small">Доход</span><b id="esRate"></b></div>
        <div><span class="muted small">В кассах</span><b id="esCash"></b></div>
        <div><span class="muted small">Стоимость</span><b id="esValue"></b></div>
        <button class="btn gold" data-act="pcollectAll">💰 Собрать всё</button>
      </div>
    </div>
    <div class="panel"><h3>Мои объекты <span id="esCount"></span></h3><div id="esMine" class="estate-grid"></div></div>
    <div class="panel">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Рынок</h3>
        <div class="seg" id="esKind"><button data-act="eskind" data-k="flat">🏠 Квартиры</button><button data-act="eskind" data-k="biz">💼 Бизнес</button></div></div>
      <div id="esMarket" class="estate-grid" style="margin-top:12px"></div>
      <div class="rules" style="margin-top:12px">
        🏠 <b>Квартира</b> приносит деньги, только когда сдана. Выбирай жильца: у ненадёжных ставка выше, но они могут сбежать с кассой.<br>
        💼 <b>Бизнес</b> работает сам, но бывают налоговые проверки, поломки и ажиотаж.<br>
        💰 Касса копит максимум 60 минут дохода — не забывай собирать. Продажа — 70% от вложенного.
        При конфискации мама забирает половину собранного.</div>
    </div>`;
}
function estateRender() {
  if (!S.me || !S.built || !S.propsCatalog) return;
  if (!$('#esMine')) estateBuild();
  renderEstateMine();
  renderEstateMarket();
  updateEstateLive();
}
function renderEstateMine() {
  const list = S.me.estate || [];
  if (!changed('estate', list.map((p) => [p.id, p.level, p.state, p.tenant, p.rentUntil, p.offers, p.rate, p.upgrade, p.sell]))) return;
  $('#esCount').textContent = `${list.length}/${S.maxProps}`;
  $('#esMine').innerHTML = list.length ? list.map((p) => {
    const def = estDef(p);
    let status;
    if (def.kind === 'biz') status = `💼 Работает · <b>${rub(p.rate)}/мин</b>`;
    else if (p.state === 'rented') status = `${p.tenant.emoji} ${esc(p.tenant.name)} · <b>${rub(p.rate)}/мин</b> · съедет через <span data-left="${p.rentUntil}"></span>`;
    else status = '<span class="neg">🔑 Пустует — денег не приносит</span>';
    let offers = '';
    if (def.kind === 'flat' && p.state !== 'rented') {
      offers = p.offers ? `<div class="offers">${p.offers.map((o, i) => `
        <button class="offer" data-act="prent" data-id="${p.id}" data-idx="${i}">
          <span>${o.emoji} <b>${esc(o.name)}</b><br><span class="small muted">${o.mins} мин · надёжность ${stars(o.risk)}</span></span>
          <b style="color:var(--gold)">${rub(def.income * estLevelMult(def, p.level) * o.k)}/мин</b></button>`).join('')}</div>
          <button class="btn small" data-act="poffers" data-id="${p.id}">🔄 Другие жильцы</button>`
        : `<button class="btn small primary" data-act="poffers" data-id="${p.id}">🔑 Сдать — найти жильцов</button>`;
    }
    return `<div class="estate-card ${def.kind}">
      <div class="row"><b>${def.emoji} ${def.name}</b><span class="badge">ур. ${p.level}/${p.maxLevel}</span></div>
      <div class="small">${status}</div>
      <div class="row"><span class="muted">Касса</span><b data-cash="${p.id}" style="color:var(--gold)"></b></div>
      <div class="progress"><div data-cashbar="${p.id}"></div></div>
      ${offers}
      <div class="row acts">
        <button class="btn small green" data-act="pcollect" data-id="${p.id}">💰 Собрать</button>
        ${p.upgrade ? `<button class="btn small" data-act="pupgrade" data-id="${p.id}">⬆️ ${def.kind === 'flat' ? 'Ремонт' : 'Улучшить'} ${rub(p.upgrade)}</button>` : '<span class="small muted">макс. уровень</span>'}
        ${p.state === 'rented' ? `<button class="btn small" data-act="pevict" data-id="${p.id}">🚪 Выселить</button>` : ''}
        <button class="btn small red" data-act="psell" data-id="${p.id}">Продать ${rub(p.sell)}</button>
      </div></div>`;
  }).join('') : '<div class="muted">Пока ничего нет. Купи что-нибудь на рынке ниже 👇</div>';
  updateEstateLive();
}
function renderEstateMarket() {
  const kind = S.estateKind;
  const items = Object.entries(S.propsCatalog).filter(([, d]) => d.kind === kind);
  if (!changed('market', [kind, items.map(([, d]) => S.me.balance >= d.price), (S.me.estate || []).length])) return;
  document.querySelectorAll('#esKind button').forEach((b) => b.classList.toggle('active', b.dataset.k === kind));
  const full = (S.me.estate || []).length >= S.maxProps;
  $('#esMarket').innerHTML = items.map(([id, d]) => {
    const can = S.me.balance >= d.price && !full;
    return `<div class="estate-card market">
      <div class="est-emoji">${d.emoji}</div>
      <b>${d.name}</b>
      <div class="row"><span class="muted">Цена</span><b style="color:var(--gold)">${rub(d.price)}</b></div>
      <div class="row"><span class="muted">${kind === 'flat' ? 'Аренда' : 'Доход'}</span><b>${rub(d.income)}/мин</b></div>
      <div class="row"><span class="muted">Окупится</span><span>≈ ${Math.round(d.price / d.income)} мин</span></div>
      <button class="btn small ${can ? 'primary' : ''}" data-act="pbuy" data-type="${id}" ${can ? '' : 'disabled'}>${full ? 'Нет места' : can ? 'Купить' : 'Не хватает денег'}</button>
    </div>`;
  }).join('');
}
let estLast = 0;
function updateEstateLive() {
  if (!S.me || !$('#esMine') || Date.now() - estLast < 200) return;
  estLast = Date.now();
  const list = S.me.estate || [];
  let cash = 0, rate = 0;
  for (const p of list) {
    const c = liveCash(p);
    cash += c; if (!(p.state === 'rented' && sNow() >= p.rentUntil)) rate += p.rate;
    const el = document.querySelector(`[data-cash="${p.id}"]`);
    if (el) {
      const txt = `${rub(Math.floor(c))} / ${rub(p.cap)}`;
      if (el.textContent !== txt) el.textContent = txt;
      document.querySelector(`[data-cashbar="${p.id}"]`).style.width = Math.min(100, (c / p.cap) * 100) + '%';
    }
  }
  document.querySelectorAll('[data-left]').forEach((e) => { e.textContent = fmtDur(Number(e.dataset.left) - sNow()); });
  $('#esRate').textContent = `${rub(rate)}/мин`;
  $('#esCash').textContent = rub(Math.floor(cash));
  $('#esValue').textContent = rub(list.reduce((s, p) => s + p.sell, 0));
}

// хуки в общий цикл
const _v2OnMeEstate = v2OnMe;
v2OnMe = function () { _v2OnMeEstate(); estateRender(); };
const _v2FrameEstate = v2Frame;
v2Frame = function () { _v2FrameEstate(); if (S.tab === 'estate') updateEstateLive(); };
socket.on('propEvent', (e) => toast(e.text, e.text.startsWith('🌟') ? 'ok' : 'bad'));

function showCollect(r) {
  if (!r) return;
  toast(`💰 Собрано ${rub(r.total)}${r.taken ? ` (мама забрала ${rub(r.taken)})` : ''}`, 'ok');
}
Object.assign(ACT, {
  eskind(b) { S.estateKind = b.dataset.k; renderEstateMarket(); },
  async pbuy(b) {
    const d = S.propsCatalog[b.dataset.type];
    const r = await emit('prop:buy', { type: b.dataset.type });
    if (r) { toast(`🏢 Куплено: ${d.emoji} ${d.name}`, 'ok'); confetti(40); }
  },
  poffers(b) { emit('prop:offers', { id: Number(b.dataset.id) }); },
  async prent(b) {
    const r = await emit('prop:rent', { id: Number(b.dataset.id), idx: Number(b.dataset.idx) });
    if (r) toast('🔑 Квартира сдана!', 'ok');
  },
  pevict(b) { if (confirm('Выселить жильца? Квартира перестанет приносить деньги.')) emit('prop:evict', { id: Number(b.dataset.id) }); },
  async pcollect(b) { showCollect(await emit('prop:collect', { id: Number(b.dataset.id) })); },
  async pcollectAll() { showCollect(await emit('prop:collect', { id: 'all' })); },
  async pupgrade(b) { const r = await emit('prop:upgrade', { id: Number(b.dataset.id) }); if (r) toast(`⬆️ Уровень ${r.level}!`, 'ok'); },
  async psell(b) {
    const p = S.me.estate.find((x) => x.id === Number(b.dataset.id));
    const d = estDef(p);
    if (!confirm(`Продать «${d.name}» за ${rub(p.sell)}? Касса соберётся автоматически.`)) return;
    const r = await emit('prop:sell', { id: p.id });
    if (r) toast(`💼 Продано за ${rub(r.price)}${r.cash ? ` + касса ${rub(r.cash)}` : ''}`, 'ok');
  },
});
