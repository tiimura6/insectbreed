#!/usr/bin/env node
/*
 * JF育成アプリ 経済シミュレーター
 *
 * index.html のスクリプトをそのまま Node の vm で動かし(数値・ロジックを複製しない)、
 * 方針(ストラテジー)ごとに 24 か月を自動プレイして収支を集計する。
 * 本体には一切手を入れない。
 *
 * 使い方: node tools/sim.js [runs=200] [months=24]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RUNS = parseInt(process.argv[2] || '200', 10);
const MONTHS = parseInt(process.argv[3] || '24', 10);
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SRC0 = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));
const TAIL = SRC0.lastIndexOf('})();');
// 本体の閉じ括弧の直前に、内部状態へアクセスする口だけを差し込む
const SRC = SRC0.slice(0, TAIL) + 'globalThis.__G={ev:function(c){return eval(c);}};\n' + SRC0.slice(TAIL);

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeGame(seed) {
  const els = {};
  const el = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, querySelectorAll() { return []; }, focus() {}, value: '', innerHTML: '', textContent: '' });
  const ctx = {
    document: { getElementById: id => els[id] || (els[id] = el()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElementNS: () => el() },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    matchMedia: () => ({ matches: true }), console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.__rng = mulberry(seed);
  vm.runInContext('Math.random=__rng;', ctx);
  vm.runInContext(SRC, ctx);
  const G = ctx.__G;
  // 描画は状態を変えないので、速度のために止める。委託の結果を取り出すためにラップする
  G.ev('renderAll=function(){};renderHome=function(){};renderShop=function(){};renderGather=function(){};' +
       'var __o=settleMarket;settleMarket=function(){var r=__o();globalThis.__mk=r;return r;};');
  const $ = new Proxy(els, { get: (t, k) => t[k] || (t[k] = el()) });
  return { G, els: $, ctx };
}

/* ---------------- 方針 ---------------- */
// h: 月と月のあいだの現実時間(時間)。0=一気に月送り / 24=1日1回プレイ
const STRATS = {
  idle:      { label: '放置(採集せず世話だけ)', gathers: 0 },
  local:     { label: '地元採集→即出品(UI既定価格)', gathers: 10, ratio: 1.0, travel: 'none' },
  localLow:  { label: '地元採集→安値出品(相場の70%)', gathers: 10, ratio: 0.7, travel: 'none' },
  grind:     { label: '地元で採集を上限まで+ケース増設', gathers: 50, ratio: 0.8, travel: 'none', buyCases: { M: 3, L: 3 } },
  travel:    { label: '遠征あり(移動費を払う)', gathers: 10, ratio: 0.8, travel: 'pay', buyCases: { M: 3, L: 3 } },
  kokuwa:    { label: 'コクワ繁殖特化(小型ケース)', gathers: 10, ratio: 0.8, travel: 'none', breed: 'kokuwa', buyCases: { S: 6 } },
  oku:       { label: 'オオクワ狙い+繁殖', gathers: 30, ratio: 0.8, travel: 'none', breed: 'oku', focus: 'oku', buyCases: { M: 6 } },
  give:      { label: '地元採集+安い個体は譲渡して入れ替え', gathers: 50, ratio: 0.8, travel: 'none', buyCases: { M: 3, L: 3 }, give: true },
  okuFarm:   { label: '上限テスト: オオクワ繁殖場(ペア・中型8・1万pt から、幼虫は終齢で売る)', gathers: 0, ratio: 0.8, travel: 'none', breed: 'oku', larvaHold: true, setup: 'okuFarm', sellIdle: true },
  okuFarmQ:  { label: '上限テスト: 同上・幼虫は孵化直後に売る', gathers: 0, ratio: 0.8, travel: 'none', breed: 'oku', setup: 'okuFarm', sellHatch: true, sellIdle: true },
};

function runOne(stratKey, seed, startMonth, h) {
  const st = STRATS[stratKey];
  const { G, els } = makeGame(seed);
  const E = c => G.ev(c);
  E('s.month=' + startMonth);
  if (st.setup === 'okuFarm') {
    E("s.pts=10000;s.cs={S:0,M:8,L:0};s.cases=8;s.insects=[" +
      "{id:101,sp:'oku',stage:'成虫',sex:'♂',size:55,w:0,food:80,wet:60,fresh:80,g:0,age:0,touched:false,defect:false,place:'茨城県・平地',cm:s.month,gene:1,cbf:0,mated:false,laying:false,hurt:false}," +
      "{id:102,sp:'oku',stage:'成虫',sex:'♀',size:40,w:0,food:80,wet:60,fresh:80,g:0,age:0,touched:false,defect:false,place:'茨城県・平地',cm:s.month,gene:1,cbf:0,mated:false,laying:false,hurt:false}];s.nid=200;");
  }
  const S = () => E('s');
  const F = { fairValue: E('fairValue'), chance: E('chance'), present: E('present'), env: E('env'), travelCost: E('travelCost'), SPID: E('SPID'), NEED: E('NEED') };
  const HAS_CAND = E('typeof takeCand') === 'function';
  const SLOTS = () => E('typeof slots') === 'function' ? E('slots()') : 4;
  const firstX = d => (E('typeof firstVisit') === 'function' && E('firstVisit')(d)) ? E('FIRSTX') : 1;
  const m = { gives: 0, min: S().pts, travel: 0, method: 0, care: 0, shop: 0, caseFee: 0, listFee: 0, sales: 0, sold: 0, oku: 0, okuSales: 0, deaths: 0, neglectDeaths: 0, defect: 0, emerged: 0, gathers: 0, bySp: {}, curve: [] };
  const fair = (i) => F.fairValue(i, 100);
  const evCache = {};
  const evOf = (spId, adult) => {
    const ck = spId + adult + S().month; if (evCache[ck] !== undefined) return evCache[ck];
    return (evCache[ck] = evOf0(spId, adult));
  };
  const evOf0 = (spId, adult) => {
    const sp = F.SPID[spId];
    if (sp.prot) return 0;
    if (adult) return (fair({ sp: spId, stage: '成虫', sex: '♂', size: sp.m, defect: false }) + fair({ sp: spId, stage: '成虫', sex: '♀', size: sp.f, defect: false })) / 2;
    return fair({ sp: spId, stage: '幼虫', w: 11, defect: false });
  };

  // 採集の計画: その月の候補(都道府県×地形×方法×時間帯)を期待値で選ぶ
  function planGather() {
    const s = S();
    const PREF = E('PREF'), SP = E('SP'), METH = E('METH');
    const cands = st.travel === 'none' ? [s.loc] : PREF.map(p => p.id);
    const mo = E('moon()');
    let best = null;
    for (const d of cands) {
      for (const ter of ['plain', 'mtn']) {
        const e = F.env(d, ter);
        for (const meth of ['sap', 'light', 'rot', 'trap']) {
          for (let t = 0; t < 4; t++) {
            E(`method='${meth}';tod=${t};`);
            let v = 0;
            for (const sp of SP) {
              if (sp.prot || !F.present(sp, d, ter)) continue;
              const w = st.focus && sp.id !== st.focus ? 0.05 : 1;
              v += w * F.chance(sp, e, mo) * evOf(sp.id, true);
              if (meth === 'rot' && (e.si === 0 || e.si === 3)) {
                const pl = Math.min(.8, sp.base * .9 * (sp.aff.rot || .5) * ((e.weather === '雨' || e.weather === '雪') ? .6 : 1));
                v += w * pl * evOf(sp.id, false);
              }
            }
            const cost = (st.travel === 'hack' ? 0 : F.travelCost(s.loc, d)) + METH[meth].cost;
            v *= firstX(d);
            const score = v * 0.5 - cost; // 半分しか売れない想定で割り引く
            if (!best || score > best.score) best = { d, ter, meth, t, score, cost };
          }
        }
      }
    }
    return best;
  }

  const keepSet = () => {
    const s = S();
    if (!st.breed) return new Set();
    const k = new Set();
    s.insects.forEach(i => { if (i.sp === st.breed) k.add(i.id); });
    return k;
  };

  function gatherPhase() {
    if (!st.gathers) return;
    const home = S().loc;
    for (let g = 0; g < st.gathers; g++) {
      let s = S();
      if (st.give && s.cases - s.insects.length <= 0) {
        const keep = keepSet();
        const low = s.insects.filter(i => !keep.has(i.id) && i.stage !== '蛹').map(i => ({ i, v: fair(i) })).sort((a, b) => a.v - b.v)[0];
        if (low && low.v < 300) { E(`s.insects=s.insects.filter(function(i){return i.id!==${low.i.id};});`); m.gives++; }
        s = S();
      }
      if (s.cases - s.insects.length <= 0) break;
      if (HAS_CAND && s.gm >= E('GMAX')) break;
      const plan = planGather();
      if (!plan) break;
      E(`dest='${plan.d}';terr='${plan.ter}';method='${plan.meth}';tod=${plan.t};pendingRestore=false;`);
      if (st.travel === 'hack') E(`s.loc='${plan.d}'`);
      const cost = E('travelCost(s.loc,dest)+METH[method].cost');
      if (s.pts < cost + (cost ? 300 : 0)) break;
      const before = new Set(s.insects.map(i => i.id));
      const p0 = s.pts;
      E('runGather()');
      m.gathers++;
      const tc = E('travelCost(s.loc,dest)');
      m.travel += Math.min(tc, p0 - S().pts); m.method += (p0 - S().pts) - Math.min(tc, p0 - S().pts);
      if (HAS_CAND) takePhase(before);
      S().insects.forEach(i => { if (!before.has(i.id) && i.sp === 'oku') m.oku++; });
      if (st.travel === 'hack') E(`s.loc='${home}'`);
    }
  }

  // 新仕様: 見つけた個体から、値打ちの高い順に持ち帰る。give なら安い手持ちを譲渡して入れ替える
  function takePhase(before) {
    const listed = () => S().cand.map((c, k) => ({ k, v: fair({ sp: c.sp, stage: c.stage, sex: c.sex, size: c.size, w: c.w, defect: false }), c }))
      .filter(x => !F.SPID[x.c.sp].prot).sort((a, b) => b.v - a.v);
    for (let guard = 0; guard < 10; guard++) {
      const L = listed();
      const want = L.find(x => E('roomFor')(x.c.sp) && S().cases - S().insects.length > 0);
      if (want) { E('takeCand(' + want.k + ')'); continue; }
      if (!st.give || !L.length) break;
      const keep = keepSet();
      const mine = S().insects.filter(i => !keep.has(i.id) && i.stage !== '蛹' && !before.has(-1)).map(i => ({ i, v: fair(i) })).sort((a, b) => a.v - b.v);
      if (!mine.length || mine[0].v * 2 > L[0].v) break;
      const gid = mine[0].i.id;
      E(`s.insects=s.insects.filter(function(i){return i.id!==${gid};});`); m.gives++;
    }
    E('leaveCand()');
  }

  function buy(k) { const p0 = S().pts; E(`buy('${k}')`); m.shop += p0 - S().pts; return p0 !== S().pts; }

  function casePhase() {
    const CS = E('CS');
    if (st.sellIdle && E('typeof sellCase') === 'function') {
      const s0 = S();
      const pending = s0.insects.some(i => i.sp === st.breed && i.stage === '成虫' && i.sex === '♀');
      if (!pending && s0.cases - s0.insects.length > 1) { for (const z of ['S', 'M', 'L']) { const p0 = S().pts; E(`sellCase('${z}')`); if (S().pts !== p0) { m.shop -= S().pts - p0; break; } } }
    }
    if (!st.buyCases) return;
    for (const z of Object.keys(st.buyCases)) {
      while (S().cs[z] < st.buyCases[z] && S().cases < 8 && S().pts > CS[z].p + 1500) { if (!buy('case' + z)) break; }
    }
  }

  function sellPhase() {
    const s = S();
    const keep = keepSet();
    // 繁殖用に、雄1・雌1の成虫は残す
    if (st.breed) {
      const ad = s.insects.filter(i => i.sp === st.breed && i.stage === '成虫');
      const males = ad.filter(i => i.sex === '♂').sort((a, b) => b.size - a.size);
      males.slice(1).forEach(i => keep.delete(i.id));
      // 幼虫は残しすぎない: ケースの半分まで
      const larvae = s.insects.filter(i => i.sp === st.breed && i.stage !== '成虫');
      if (!st.larvaHold) larvae.slice(Math.max(2, Math.floor(s.cases / 2))).forEach(i => keep.delete(i.id));
    }
    if (st.larvaHold) s.insects.forEach(i => { if (i.stage === '幼虫' && i.g >= F.NEED[i.sp] - 1) keep.delete(i.id); });
    if (st.sellHatch) s.insects.forEach(i => { if (i.stage === '幼虫') keep.delete(i.id); });
    const cands = s.insects.filter(i => !F.SPID[i.sp].prot && !keep.has(i.id) && i.stage !== '蛹')
      .map(i => ({ i, v: fair(i) })).sort((a, b) => b.v - a.v);
    for (const c of cands) {
      if (S().listings.length >= SLOTS()) break;
      if (st.neglect && c.v < st.neglect) continue; // 安い個体は出品せず、死なせる
      els['sell-ins'].value = String(c.i.id);
      els['sell-price'].value = String(Math.max(10, Math.round(c.v * st.ratio / 10) * 10));
      E('sellGo()');
    }
  }

  function breedPhase() {
    if (!st.breed) return;
    for (let k = 0; k < 3; k++) { if (E(`(function(){var p=unmatedFemale();return p&&p.f.sp==='${st.breed}';})()`)) E('pair()'); else break; }
    const s = S();
    const fem = s.insects.filter(i => i.sp === st.breed && i.stage === '成虫' && i.sex === '♀' && i.mated && !i.laying);
    for (const f of fem) {
      const free = S().cases - S().insects.length;
      if (free < 2) break;
      if (S().inv.set < 1 && !buy('set')) break;
      E(`s.sel=${f.id};laySet();`);
    }
  }

  function carePhase() {
    const s = S();
    const neglectIds = new Set();
    if (st.neglect) s.insects.forEach(i => { if (!E('SPID')[i.sp].prot && fair(i) < st.neglect && !keepSet().has(i.id)) neglectIds.add(i.id); });
    for (const i of s.insects.slice()) {
      if (neglectIds.has(i.id)) continue;
      E('s.sel=' + i.id);
      if (i.stage === '幼虫') {
        if (i.food < 30 || i.fresh < 30) {
          if (S().inv.matB < 1) buy('matB');
          els['matkind'].value = 'matB';
          if (S().inv.matB >= 1) { E("care('mat')"); m.care += 0; }
        }
        let n = 0; while (i.wet < 30 && n++ < 10) E("care('mist')");
      } else if (i.stage === '成虫') {
        let n = 0;
        while (i.food < 30 && n++ < 6) { if (S().inv.jelly < 1 && !buy('jelly')) break; E("care('feed')"); }
        if (i.fresh < 20) E("care('clean')");
        n = 0; while (i.wet < 30 && n++ < 10) E("care('mist')");
      } else if (i.stage === '蛹' && HAS_CAND) {
        let n = 0; while (i.wet < 30 && n++ < 10) E("care('mist')"); // 新仕様: 蛹への霧吹きは触った扱いにならない
      }
    }
    return neglectIds;
  }

  for (let mo = 0; mo < MONTHS; mo++) {
    if (h) E(`decay(${h})`);
    casePhase();
    gatherPhase();
    breedPhase();
    sellPhase();
    const neg = carePhase();
    // 進める(危険でも進める=放置死を含む)
    const pre = S();
    const fee = Math.min(E('caseFee()'), pre.pts);
    const liveIds = new Set(pre.insects.map(i => i.id));
    const listSp = {}; pre.listings.forEach(L => { listSp[L.lid] = L.ins.sp; });
    const p0 = pre.pts;
    E('doAdvance()');
    const s = S();
    const r = G.ctx ? null : null;
    const mk = E('globalThis.__mk');
    m.caseFee += fee; m.sales += mk.gain; m.listFee += mk.fee; m.sold += mk.sold;
    // 売れた種の内訳
    const remain = new Set(s.listings.map(L => L.lid));
    Object.keys(listSp).forEach(lid => { if (!remain.has(+lid)) { const sp = listSp[lid]; m.bySp[sp] = (m.bySp[sp] || 0) + 1; } });
    m.okuSales += mk.items.filter(t => t.indexOf('オオクワガタ') === 0).reduce((a, t) => a + parseInt(t.replace(/[^0-9]/g, ''), 10), 0);
    s.dead.forEach(d => { m.deaths++; if (neg.has(d.ins.id)) m.neglectDeaths++; });
    s.insects.forEach(i => { if (i.stage === '成虫' && i.age === 0 && liveIds.has(i.id)) { m.emerged++; if (i.defect) m.defect++; } });
    m.min = Math.min(m.min, s.pts);
    m.curve.push(s.pts);
    void p0; void r;
  }
  const s = S();
  m.end = s.pts;
  m.assets = s.insects.reduce((a, i) => a + (E('SPID')[i.sp].prot ? 0 : fair(i)), 0) + s.listings.reduce((a, L) => a + L.price * .9, 0);
  m.inv = s.insects.length; m.cases = s.cases;
  return m;
}

/* ---------------- 種ごとの理論値(ケース1個・1か月あたりの稼ぎ) ---------------- */
function speciesTable() {
  const { G } = makeGame(1);
  const E = c => G.ev(c);
  E('s.month=7;s.loc="ibaraki"');
  const SP = E('SP'), NEED = E('NEED'), LIFE = E('LIFE'), EGG = E('EGG'), CS = E('CS');
  const rows = [];
  for (const sp of SP) {
    if (sp.prot) continue;
    const z = E('szOf')(sp.id);
    const fv = (o) => E('fairValue')(o, 100);
    const adM = fv({ sp: sp.id, stage: '成虫', sex: '♂', size: Math.round(sp.m * 1.05), defect: false });
    const adF = fv({ sp: sp.id, stage: '成虫', sex: '♀', size: Math.round(sp.f * 1.05), defect: false });
    const adult = (adM + adF) / 2;
    const larva5 = fv({ sp: sp.id, stage: '幼虫', w: 5, defect: false });
    const need = NEED[sp.id];
    // 関東: 冬(12-2)は成長停止(気温5℃<8℃) → 実月数は need×12/9 程度。羽化待ちは平均2か月と置く
    const months = Math.ceil(need * 12 / 9) + 2;
    const fee = CS[z].f;
    const matL = E('typeof MATL') === 'number' ? E('MATL') : 10;
    const matPerMonth = 1300 / matL / 2; // 1日1回プレイで 2か月に1L
    const raiseProfit = adult - larva5 - months * (fee + matPerMonth);
    rows.push({
      種: sp.n, ケース: z, 卵数: EGG[sp.id], 成長月: need, 実月数: months, 寿命: LIFE[sp.id],
      孵化幼虫の相場: larva5, 成虫の相場平均: Math.round(adult),
      '1腹を幼虫で売る': larva5 * EGG[sp.id],
      '育てた上乗せ/匹': Math.round(raiseProfit),
      '上乗せ/ケース月': Math.round(raiseProfit / months),
    });
  }
  return rows;
}

/* ---------------- 出力 ---------------- */
function q(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function yen(n) { return Math.round(n).toLocaleString('ja-JP'); }
function table(rows) {
  const keys = Object.keys(rows[0]);
  let o = '| ' + keys.join(' | ') + ' |\n|' + keys.map(() => '---').join('|') + '|\n';
  rows.forEach(r => { o += '| ' + keys.map(k => typeof r[k] === 'number' ? yen(r[k]) : r[k]).join(' | ') + ' |\n'; });
  return o;
}

function main() {
  const out = [];
  out.push(`# 経済シミュレーション結果\n\n実行: ${RUNS}回/条件、${MONTHS}か月、出発地 茨城県、初期 1,280pt・中型1・大型1・カブト幼虫1。\n`);
  for (const [h, hl] of [[24, '1日1回プレイ(月の間に現実24時間)'], [0, '一気に月送り(現実時間の劣化なし)']]) {
    for (const sm of [11, 5]) {
      const rows = [];
      for (const k of Object.keys(STRATS)) {
        const R = [];
        for (let r = 0; r < RUNS; r++) R.push(runOne(k, 1000 + r * 7919 + sm, sm, h));
        const sumSp = {}; R.forEach(x => Object.entries(x.bySp).forEach(([sp, n]) => { sumSp[sp] = (sumSp[sp] || 0) + n; }));
        const tot = Object.values(sumSp).reduce((a, b) => a + b, 0) || 1;
        const top = Object.entries(sumSp).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sp, n]) => `${sp} ${Math.round(n / tot * 100)}%`).join(', ');
        const m12 = R.map(x => x.curve[Math.min(11, x.curve.length - 1)]);
        rows.push({
          方針: STRATS[k].label,
          '12か月後pt(中央)': q(m12, .5),
          [`${MONTHS}か月後pt(中央)`]: q(R.map(x => x.end), .5),
          '下位10%': q(R.map(x => x.end), .1),
          '上位10%': q(R.map(x => x.end), .9),
          '最低残高(中央)': q(R.map(x => x.min), .5),
          '売上/月': avg(R.map(x => x.sales)) / MONTHS,
          'ケース費/月': avg(R.map(x => x.caseFee)) / MONTHS,
          '移動+道具/月': avg(R.map(x => x.travel + x.method)) / MONTHS,
          '用品購入/月': avg(R.map(x => x.shop)) / MONTHS,
          'オオクワ捕獲/年': avg(R.map(x => x.oku)) * 12 / MONTHS,
          'オオクワ売上比': (avg(R.map(x => x.okuSales)) / Math.max(1, avg(R.map(x => x.sales))) * 100).toFixed(0) + '%',
          '羽化不全率': (avg(R.map(x => x.defect)) / Math.max(1e-9, avg(R.map(x => x.emerged))) * 100).toFixed(0) + '%',
          '死亡/年': avg(R.map(x => x.deaths)) * 12 / MONTHS,
          '売れた種上位': top || '-',
        });
      }
      out.push(`## ${hl}・開始 ${sm}月\n\n` + table(rows));
    }
  }
  out.push('## 種ごとの理論値(関東・夏の相場、状態100、サイズは平均の1.05倍)\n\n' + table(speciesTable()));
  const txt = out.join('\n');
  console.log(txt);
  const dst = path.resolve(__dirname, process.env.OUT || 'sim-result.md');
  fs.writeFileSync(dst, txt);
}
main();
