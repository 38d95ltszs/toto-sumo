// ============================================================
// トト相撲 データ取得スクリプト（GitHub Actions用）
// スポーツナビの取組ページから幕内の取組・結果を取得し
// data/basho.json に保存する。依存パッケージなし（Node 20+）。
//
// 使い方:  node scraper/fetch_basho.mjs
// ============================================================
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const OUT = "data/basho.json";
const BASE = "https://sports.yahoo.co.jp/sumo/torikumi";
const UA = "toto-sumo-bot/1.0 (personal fan game; low frequency daily fetch)";

// ---------- 場所カレンダー（奇数月・第2日曜初日・15日間）JST ----------
const JST = 9 * 3600e3;
function jstToday() {
  const d = new Date(Date.now() + JST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function secondSunday(y, m) {
  const wd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((7 - wd) % 7) + 7;
}
function currentBasho() {
  const today = jstToday();
  const y0 = new Date(today).getUTCFullYear();
  for (const y of [y0 - 1, y0]) {
    for (const m of [1, 3, 5, 7, 9, 11]) {
      const start = Date.UTC(y, m - 1, secondSunday(y, m));
      const day = Math.floor((today - start) / 86400e3) + 1;
      if (day >= 1 && day <= 16) { // 千秋楽翌日も1回動かす(最終結果回収)
        return { y, m, day: Math.min(day, 15), key: `${y}-${String(m).padStart(2, "0")}` };
      }
    }
  }
  return null;
}

// ---------- 番付文字列の正規化 ----------
function normRank(s) {
  s = s.replace(/^[東西]/, "");
  if (s === "横綱") return "Y";
  if (s === "大関") return "O";
  if (s === "関脇") return "S";
  if (s === "小結") return "K";
  let m = s.match(/^前頭(筆頭|(\d+)枚目)$/);
  if (m) return "M" + (m[2] || 1);
  m = s.match(/^十両(筆頭|(\d+)枚目)$/);
  if (m) return "J" + (m[2] || 1);
  return null;
}
const RANK_RE = /^[東西]?(横綱|大関|関脇|小結|前頭(筆頭|\d+枚目)|十両(筆頭|\d+枚目))$/;
const REC_RE = /^(\d+)勝(\d+)敗/;

// ---------- 1日分のページをパース ----------
// 戻り値: [{eRank,eName,eRec,eMark, k, wRank,wName,wRec,wMark}]
function parseDay(html) {
  // 最初の<table>（幕内）のみ対象
  const t0 = html.indexOf("<table");
  if (t0 < 0) return [];
  const t1 = html.indexOf("</table>", t0);
  const table = html.slice(t0, t1);
  const rows = table.split(/<tr[\s>]/).slice(1);
  const bouts = [];
  for (const row of rows) {
    // タグ除去 → トークン列
    const tokens = row
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, " $1 ") // 勝敗マークがimgの場合
      .replace(/<[^>]*>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .split("\n").map(s => s.trim()).filter(Boolean)
      .filter(s => !/^https?:/.test(s));
    // 期待順: 東番付, [○●], 東力士名, 東成績, 決まり手, [○●], 西力士名, 西成績, 西番付
    const rankIdx = tokens.map((t, i) => RANK_RE.test(t) ? i : -1).filter(i => i >= 0);
    if (rankIdx.length < 2) continue;
    const recIdx = tokens.map((t, i) => REC_RE.test(t) ? i : -1).filter(i => i >= 0);
    if (recIdx.length < 2) continue;
    const seg = (a, b) => tokens.slice(a + 1, b);
    const isMark = t => /^[○●□■]$/.test(t);
    const eRank = normRank(tokens[rankIdx[0]]);
    const wRank = normRank(tokens[rankIdx[rankIdx.length - 1]]);
    if (!eRank || !wRank) continue;
    // 東側: 番付〜成績 の間で名前を拾う（マークが名前の前後に付く場合あり）
    const eSeg = seg(rankIdx[0], recIdx[0]);
    let eMark = eSeg.find(isMark) || null;
    const eName = eSeg.find(t => !isMark(t));
    const eRec = tokens[recIdx[0]];
    const wRec = tokens[recIdx[recIdx.length - 1]];
    // 中間部（東成績〜西成績）: [東マーク?] 決まり手 [西マーク?] 西名 の並び
    const mid = seg(recIdx[0], recIdx[recIdx.length - 1]);
    const nonMark = mid.filter(t => !isMark(t));
    const wName = nonMark.length ? nonMark[nonMark.length - 1] : null;
    const k = nonMark.length > 1 ? nonMark[0] : null;
    // マークの帰属: 決まり手トークンより前=東 / 後=西
    let wMark = null;
    const kPos = k ? mid.indexOf(k) : -1;
    mid.forEach((t, i) => {
      if (!isMark(t)) return;
      if (kPos >= 0 ? i < kPos : !eMark) { if (!eMark) eMark = t; }
      else if (!wMark) wMark = t;
    });
    // 西成績〜西番付の間のマークは西
    seg(recIdx[recIdx.length - 1], rankIdx[rankIdx.length - 1]).forEach(t => { if (isMark(t) && !wMark) wMark = t; });
    if (!eName || !wName) continue;
    bouts.push({ eRank, eName, eRec, eMark, k, wRank, wName, wRec, wMark });
  }
  return bouts;
}

// ---------- 勝者判定（マーク優先、なければ星取差分） ----------
function decideWinner(b, winsMap) {
  if (b.eMark === "○" || b.eMark === "□") return "e";
  if (b.wMark === "○" || b.wMark === "□") return "w";
  if (b.eMark === "●" || b.eMark === "■") return "w";
  if (b.wMark === "●" || b.wMark === "■") return "e";
  if (!b.k || b.k === "取組前") return null;
  const ew = parseInt((b.eRec.match(REC_RE) || [])[1] || "0", 10);
  const ww = parseInt((b.wRec.match(REC_RE) || [])[1] || "0", 10);
  const prevE = winsMap[b.eName] || 0, prevW = winsMap[b.wName] || 0;
  if (ew > prevE && ww === prevW) return "e";
  if (ww > prevW && ew === prevE) return "w";
  return null;
}

// ---------- メイン ----------
const basho = currentBasho();
if (!basho) {
  console.log("場所期間外のため何もしません");
  process.exit(0);
}
console.log(`対象: ${basho.key} / ${basho.day}日目まで（+翌日の取組）`);

const yyyymm = basho.key.replace("-", "");
const days = {};
const banzuke = new Map(); // name -> rank（初出を採用）
const winsMap = {};        // 星取差分用

const fetchDays = [];
for (let d = 1; d <= Math.min(15, basho.day + 1); d++) fetchDays.push(d);

for (const d of fetchDays) {
  const url = `${BASE}/${yyyymm}/${d}`;
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.log(`day${d}: HTTP ${res.status} スキップ`); continue; }
    html = await res.text();
  } catch (e) {
    console.log(`day${d}: 取得失敗 ${e.message}`);
    continue;
  }
  const parsed = parseDay(html);
  if (!parsed.length) { console.log(`day${d}: 取組なし（未発表）`); continue; }
  const bouts = [];
  for (const b of parsed) {
    banzuke.has(b.eName) || banzuke.set(b.eName, b.eRank);
    banzuke.has(b.wName) || banzuke.set(b.wName, b.wRank);
    const win = decideWinner(b, winsMap);
    bouts.push({ e: b.eName, w: b.wName, k: (b.k && b.k !== "取組前") ? b.k : null, win });
  }
  // 星取更新（結果確定行のみ）
  for (const b of parsed) {
    if (b.k && b.k !== "取組前") {
      const ew = parseInt((b.eRec.match(REC_RE) || [])[1] || "0", 10);
      const ww = parseInt((b.wRec.match(REC_RE) || [])[1] || "0", 10);
      winsMap[b.eName] = Math.max(winsMap[b.eName] || 0, ew);
      winsMap[b.wName] = Math.max(winsMap[b.wName] || 0, ww);
    }
  }
  days[d] = bouts;
  const resolved = bouts.filter(x => x.win).length;
  console.log(`day${d}: ${bouts.length}番 (結果確定 ${resolved})`);
  await new Promise(r => setTimeout(r, 1500)); // 行儀よく1.5秒待つ
}

if (!Object.keys(days).length) {
  console.log("有効なデータが取れませんでした（既存ファイルを保持）");
  process.exit(0);
}

// 既存データとマージ（過去日の確定結果は上書きしない安全策）
let prev = null;
if (existsSync(OUT)) {
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { }
}
if (prev && prev.bashoKey === basho.key && prev.days) {
  for (const [d, bouts] of Object.entries(prev.days)) {
    const nd = days[d];
    if (!nd) { days[d] = bouts; continue; }
    // 旧データで確定済み・新データで未確定なら旧を残す
    bouts.forEach((ob, i) => { if (ob.win && nd[i] && !nd[i].win && ob.e === nd[i].e) nd[i] = ob; });
  }
}

const out = {
  bashoKey: basho.key,
  updatedAt: new Date().toISOString(),
  source: "sports.yahoo.co.jp/sumo",
  banzuke: [...banzuke.entries()].map(([name, rank]) => ({ name, rank })),
  days
};
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`書き出し完了: ${OUT} (力士${out.banzuke.length}名 / ${Object.keys(days).length}日分)`);
