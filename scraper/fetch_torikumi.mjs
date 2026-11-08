// ============================================================
// トト相撲 取組結果・前売り（割）自動取得スクリプト（GitHub Actions用）
//
// ABEMA TIMES「大相撲 取組結果」ページが日切り替えに使っているJSON
//   /list/ajax/sumo_torikumi.json?year=YYYY&month=M&day=D
// から幕内の取組（勝敗・決まり手・不戦）を取り出し、data/basho.json の days に反映する。
//
//   ・当日の勝敗 … 日が進むにつれて確定した取組から順に反映
//   ・翌日の割   … 結果なし(win:null)の前売りカードとして登録（初日は2日前の金曜から）
//
// 【取得時刻と対象日】（JST）
//   12時より前（翌朝8時の回）… 前日(N-1) と 当日(N)    ← 前日分の取りこぼし回収＋当日の割の更新
//   12時以降（19時・20時の回）… 当日(N) と 翌日(N+1)   ← 当日の勝敗＋翌日の割
//   開幕前日までは初日(1)のみ。場所期間外は何もしない。
//
// 【行儀】robots.txtを確認、1回の実行で最大2リクエスト（間隔2秒）、1日3回まで。
//   取り出すのは力士名・勝敗・決まり手という事実情報だけ（文章・画像・動画リンクは保存しない）。
//
// 【書き込みルール】
//   ・確定済みの取組結果（win が入っているもの）は、再取得で上書きしない
//   ・取得結果が想定の形でない（レイアウト変更など）ときは何も書かずに異常終了(exit 1)
//   ・ネットワーク不調・未公開日はそのまま終了(exit 0)し、次回に任せる
//   ・番付・優勝三賞・news など days 以外のフィールドには一切触れない
//
// 使い方:  node scraper/fetch_torikumi.mjs
// 依存パッケージなし（Node 20+）。テスト用: FIXTURE_DIR / FAKE_NOW 環境変数（下記）。
// ============================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DATA = "data/basho.json";
const BASE = "https://times.abema.tv";
const ENDPOINT = "/list/ajax/sumo_torikumi.json";
const UA = "toto-sumo-bot/1.0 (personal fan game; low frequency results fetch)";
const GAP_MS = 2000;
const MIN_BOUTS = 10; // 幕内は通常20〜21番。これ未満なら解析失敗とみなす

// ---- テスト用フック ----
// FIXTURE_DIR: ネットワークの代わりに <dir>/day<N>.json を読む
// FAKE_NOW:    現在時刻の差し替え（ISO8601）
const FIXTURE_DIR = process.env.FIXTURE_DIR || "";
const NOW = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now();
const DRY_RUN = process.env.DRY_RUN === "1";

class ParseError extends Error {}
class BlockedError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- カレンダー（ゲーム本体 index.html の bashoInfo と同じ規則） ----------
const JST_OFF = 9 * 3600e3;
function secondSunday(y, m) {
  const wd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((7 - wd) % 7) + 7;
}
function jstNow() {
  const d = new Date(NOW + JST_OFF);
  return {
    dateMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    hour: d.getUTCHours(),
  };
}
// 場所の初日を基準にした今日の日目（初日=1。開幕前は0以下）
function bashoDayNow(key) {
  const [y, m] = key.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, secondSunday(y, m));
  return Math.floor((jstNow().dateMs - startMs) / 86400e3) + 1;
}
// 今回取得する日目の一覧
function targetDays(n, hour) {
  if (n === -1 || n === 0) return [1];              // 開幕2日前〜前日: 初日の割
  if (n < 1 || n > 16) return [];                    // 場所期間外
  const days = hour < 12 ? [n - 1, n] : [n, n + 1];
  return days.filter(d => d >= 1 && d <= 15);
}

// ---------- robots.txt（User-agent: * の Disallow だけ見る簡易判定） ----------
async function robotsAllows(path) {
  if (FIXTURE_DIR) return true;
  let txt = "";
  try {
    const res = await fetch(BASE + "/robots.txt", { headers: { "User-Agent": UA } });
    if (res.status === 404) return true;
    if (!res.ok) return true; // 取得できないなら本体取得側のエラー処理に任せる
    txt = await res.text();
  } catch { return true; }
  let inStar = false, sawAgent = false;
  const disallow = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) { sawAgent = false; continue; }
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!sawAgent) inStar = false;
      sawAgent = true;
      if (v === "*") inStar = true;
    } else if (k === "disallow" && inStar && v) {
      disallow.push(v);
    }
  }
  return !disallow.some(p => path.startsWith(p));
}

// ---------- 取得 ----------
async function fetchDay(year, month, day) {
  if (FIXTURE_DIR) {
    const f = `${FIXTURE_DIR}/day${day}.json`;
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  }
  const url = `${BASE}${ENDPOINT}?year=${year}&month=${month}&day=${day}`;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  } catch (e) {
    console.log(`day${day}: 取得失敗（${e.message}）。次回に任せます。`);
    return null;
  }
  if (res.status === 403 || res.status === 429) {
    throw new BlockedError(`day${day}: HTTP ${res.status}（アクセス制限の可能性）。頻度や取得方法を見直してください。`);
  }
  if (!res.ok) {
    console.log(`day${day}: HTTP ${res.status}。次回に任せます。`);
    return null;
  }
  try { return await res.json(); }
  catch { throw new ParseError(`day${day}: JSONとして読めませんでした（仕様変更の可能性）`); }
}

// ---------- 解析（幕内テーブル=data-index="1"） ----------
const stripTags = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const WIN_MARKS = new Set(["◯", "○", "〇", "□"]);   // □=不戦勝
const LOSE_MARKS = new Set(["●", "■"]);            // ■=不戦敗

// 決まり手の表記をゲームの表記（スポナビ等と同じ慣用表記）にそろえる。
// 特に「叩き込み」は、決まり手予想（押し出し/寄り切り/はたき込み/それ以外）の判定が
// 「はたき込み」との完全一致なので、そろえないと的中判定が狂う。
const KIMARITE_NORM = {
  "叩き込み": "はたき込み", "掬い投げ": "すくい投げ", "浴せ倒し": "あびせ倒し", "浴びせ倒し": "あびせ倒し",
  "下手捻り": "下手ひねり", "上手捻り": "上手ひねり", "蹴返し": "け返し", "蹴手繰り": "けたぐり", "打っ棄り": "うっちゃり",
};
const normKimarite = k => KIMARITE_NORM[k] || k;

// 「5勝2敗8休」→ {w:5, l:2}（休は勝敗に影響しないので見ない）
function parseRecord(s) {
  const m = String(s || "").match(/(\d+)勝(\d+)敗/);
  return m ? { w: +m[1], l: +m[2] } : null;
}

function parseMakuuchi(json, day) {
  const tag = json && json.torikumi_tag;
  if (typeof tag !== "string" || !tag) throw new ParseError(`day${day}: torikumi_tag がありません`);
  const tm = tag.match(/<table[^>]*data-index="1"[^>]*>([\s\S]*?)<\/table>/);
  if (!tm) throw new ParseError(`day${day}: 幕内テーブルが見つかりません`);
  const bm = tm[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!bm) throw new ParseError(`day${day}: tbodyが見つかりません`);
  const bouts = [];
  for (const rm of bm[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...rm[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (tds.length !== 7) throw new ParseError(`day${day}: 取組行の列数が想定外(${tds.length})`);
    const nameOf = h => stripTags(h.replace(/<span[^>]*victory[^>]*>[\s\S]*?<\/span>/g, ""));
    const recOf = h => { const m = h.match(/<span[^>]*victory[^>]*>([\s\S]*?)<\/span>/); return parseRecord(m && stripTags(m[1])); };
    const e = nameOf(tds[1]), w = nameOf(tds[5]);
    const em = stripTags(tds[2]), wm = stripTags(tds[4]);
    const factor = stripTags(tds[3].replace(/<a[^>]*>[\s\S]*?<\/a>/g, ""));
    if (!e || !w) throw new ParseError(`day${day}: 力士名が空の取組があります`);
    let win = null;
    if (!em && !wm) win = null;
    else if (WIN_MARKS.has(em) && LOSE_MARKS.has(wm)) win = "e";
    else if (LOSE_MARKS.has(em) && WIN_MARKS.has(wm)) win = "w";
    else throw new ParseError(`day${day}: ${e}-${w} の勝敗マークが想定外（${em}/${wm}）`);
    const fusen = win !== null && (/不戦/.test(factor) || em === "■" || em === "□" || wm === "■" || wm === "□");
    // _er/_wr は照合用の一時情報（取組後の成績）。保存前に取り除く
    bouts.push({ e, w, k: win && !fusen ? (normKimarite(factor) || null) : null, win, fusen, _er: recOf(tds[1]), _wr: recOf(tds[5]) });
  }
  if (bouts.length < MIN_BOUTS) throw new ParseError(`day${day}: 取組数が少なすぎます(${bouts.length}番)`);
  const names = bouts.flatMap(b => [b.e, b.w]);
  if (new Set(names).size !== names.length) console.log(`day${day}: ⚠ 同じ力士が複数の取組に出ています（要確認）`);
  return bouts;
}

// ---------- 成績表示による◯●の照合 ----------
// ABEMAの表は◯●マークだけが誤っていることがある（2026年7月場所4日目で5番、
// 両力士の「n勝n敗」表示とは食い違い、成績表示側が正しかった）。
// 前日までの確定結果から「取組前の成績」を数え、◯●どおりの勝敗で表示成績に
// 一致するかを確かめる。一致せず、勝敗を入れ替えると両力士とも一致する場合は
// 成績表示に合わせて補正する。前日までのデータが揃っていない・番付に無い力士
// （十両の格上げ出場）などで数えられない取組は、◯●のまま採用する。
function verifyByRecord(fresh, days, d, makuuchiNames) {
  for (let k = 1; k < d; k++) {
    const arr = days[String(k)];
    if (!arr || !arr.length || arr.some(b => !b.win)) return { checked: 0, fixed: 0, note: `${k}日目の確定結果が揃っていないため照合を省略` };
  }
  const before = {};
  for (let k = 1; k < d; k++) {
    for (const b of days[String(k)]) {
      const winner = b.win === "e" ? b.e : b.w, loser = b.win === "e" ? b.w : b.e;
      (before[winner] ||= { w: 0, l: 0 }).w++;
      (before[loser] ||= { w: 0, l: 0 }).l++;
    }
  }
  const same = (a, b) => a && b && a.w === b.w && a.l === b.l;
  let checked = 0, fixed = 0;
  for (const b of fresh) {
    if (!b.win || !b._er || !b._wr || !makuuchiNames.has(b.e) || !makuuchiNames.has(b.w)) continue;
    const be = before[b.e] || { w: 0, l: 0 }, bw = before[b.w] || { w: 0, l: 0 };
    const ifEast = [{ w: be.w + 1, l: be.l }, { w: bw.w, l: bw.l + 1 }];
    const ifWest = [{ w: be.w, l: be.l + 1 }, { w: bw.w + 1, l: bw.l }];
    const [asMark, flipped] = b.win === "e" ? [ifEast, ifWest] : [ifWest, ifEast];
    checked++;
    if (same(asMark[0], b._er) && same(asMark[1], b._wr)) continue;
    if (same(flipped[0], b._er) && same(flipped[1], b._wr)) {
      b.win = b.win === "e" ? "w" : "e";
      fixed++;
      console.log(`day${d}: ⚠ ${b.e}-${b.w} は◯●と成績表示が矛盾。成績表示に合わせて${b.win === "e" ? b.e : b.w}の勝ちに補正`);
    } else {
      console.log(`day${d}: ⚠ ${b.e}-${b.w} は成績表示と照合できず（◯●のまま採用）`);
    }
  }
  return { checked, fixed };
}

// ---------- 統合 ----------
// 確定済み（win が入っている）取組は上書きしない。組み合わせの正本はABEMA。
function mergeDay(existing, fresh, day) {
  const old = existing || [];
  const used = new Set();
  const out = fresh.map(b => {
    const idx = old.findIndex((o, i) => !used.has(i) &&
      ((o.e === b.e && o.w === b.w) || (o.e === b.w && o.w === b.e)));
    if (idx < 0) return b;
    used.add(idx);
    const o = old[idx];
    if (!o.win) return b;                        // 既存が未確定 → 新しい情報を採用
    const swapped = o.e !== b.e;                 // 東西が逆に登録されていた場合は向きを合わせる
    let kept = swapped ? { ...o, e: o.w, w: o.e, win: o.win === "e" ? "w" : "e" } : o;
    // 勝敗は保持したまま、決まり手の表記だけゲームの表記にそろえる（手動登録の「叩き込み」等）
    if (kept.k && normKimarite(kept.k) !== kept.k) kept = { ...kept, k: normKimarite(kept.k) };
    if (b.win && b.win !== kept.win) {
      console.log(`day${day}: ⚠ ${b.e}-${b.w} の結果がABEMAと既存データで食い違い。確定済みの既存を保持します`);
    }
    return kept;
  });
  // ABEMAの表に無いが確定結果を持つ既存取組は失わないよう末尾に残す
  old.forEach((o, i) => {
    if (!used.has(i) && o.win) { console.log(`day${day}: ⚠ 確定済みの ${o.e}-${o.w} がABEMAの表に無いため保持`); out.push(o); }
  });
  return out;
}

// ---------- メイン ----------
async function main() {
  if (!existsSync(DATA)) { console.log(`${DATA} がありません。終了。`); return 0; }
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const key = data.bashoKey;
  if (!/^\d{4}-(01|03|05|07|09|11)$/.test(key || "")) {
    console.error(`bashoKey が不正です: ${JSON.stringify(key)}（YYYY-MM・奇数月）。何もしません。`);
    return 1;
  }
  const n = bashoDayNow(key);
  const days = targetDays(n, jstNow().hour);
  if (!days.length) { console.log(`${key} は場所期間外（今日=${n}日目）。何もしません。`); return 0; }
  console.log(`${key} 今日=${n}日目 / 取得対象: ${days.join(", ")}日目`);

  if (!(await robotsAllows(ENDPOINT))) {
    console.log("robots.txt が取得を許可していません。何もしません。");
    return 0;
  }

  const [year, month] = key.split("-").map(Number);
  const bzNames = new Set((data.banzuke || []).map(b => b.name));
  // 照合は幕内力士どうしの取組だけ（十両力士は十両での取組がデータに無く、成績を数えられない）
  const makuuchiNames = new Set((data.banzuke || []).filter(b => !/^J/.test(b.rank || "")).map(b => b.name));
  data.days = data.days || {};
  let changed = false;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (i > 0) await sleep(FIXTURE_DIR ? 0 : GAP_MS);
    const json = await fetchDay(year, month, d);
    if (!json) continue;
    if (json.status !== "success") { console.log(`day${d}: 未公開（status=${json.status}）。`); continue; }
    if (json.title && !String(json.title).includes(`${month}月場所`)) {
      throw new ParseError(`day${d}: 場所が想定と違います（title=${json.title}）`);
    }
    const parsed = parseMakuuchi(json, d);
    const unknown = [...new Set(parsed.flatMap(b => [b.e, b.w]).filter(nm => bzNames.size && !bzNames.has(nm)))];
    if (unknown.length) console.log(`day${d}: 番付に無い力士（十両の格上げ出場等）: ${unknown.join("、")}`);
    const v = verifyByRecord(parsed, data.days, d, makuuchiNames);
    if (v.note) console.log(`day${d}: ${v.note}`);
    const fresh = parsed.map(({ _er, _wr, ...b }) => b);
    const merged = mergeDay(data.days[String(d)], fresh, d);
    const done = merged.filter(b => b.win).length;
    if (JSON.stringify(merged) !== JSON.stringify(data.days[String(d)])) {
      data.days[String(d)] = merged;
      changed = true;
      console.log(`day${d}: 更新 ${merged.length}番（結果確定 ${done}番）`);
    } else {
      console.log(`day${d}: 変更なし（${merged.length}番・結果確定 ${done}番）`);
    }
  }

  if (!changed) { console.log("変更なし。"); return 0; }
  data.updatedAt = new Date(NOW).toISOString();
  if (DRY_RUN) { console.log("DRY_RUN: 書き込みをスキップ"); return 0; }
  // 数値キーを昇順に並べ直して書き出す（インデント1・末尾改行は既存ファイルに合わせる）
  data.days = Object.fromEntries(Object.keys(data.days).sort((a, b) => a - b).map(k => [k, data.days[k]]));
  writeFileSync(DATA, JSON.stringify(data, null, 1) + "\n");
  console.log("data/basho.json を更新しました。");
  return 0;
}

main().then(code => process.exit(code)).catch(e => {
  if (e instanceof ParseError || e instanceof BlockedError) {
    console.error("::error::" + e.message);
    process.exit(1);
  }
  console.log("想定外のエラー（既存データを保持して終了）:", e.message);
  process.exit(0);
});
