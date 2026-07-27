// ============================================================
// トト相撲 サーバー精算 Edge Function（Supabase / Deno）
//
// 配置先: supabase/functions/settle-basho/index.ts
// デプロイ: supabase functions deploy settle-basho --no-verify-jwt
//
// 役割:
//   千秋楽が終わりオフシーズンに入ったら、アプリを一度も開いていない
//   プレイヤーの分も含めて全員の最終持ち米(final_points)をサーバー側で確定する。
//   これにより水曜10:00の番付編成会議で、相対順位（トト番付）が正しく決まる。
//
//   ・data/basho.json（15日分の結果＋優勝三賞）を読む
//   ・service_roleで全プレイヤーの player_saves を読む
//   ・各プレイヤーの未精算ベットを「ベットに焼き込み済みのオッズ」で精算し、
//     優勝・三賞の倍付けまで適用して final_points を算出
//   ・players テーブルの final_points / hits / bets を更新
//
//   精算ロジックはクライアント(index.html)の settlePending / processFinish と同じ。
//   ルールを変えたら両方直すこと（node検証スクリプトで一致確認できる）。
//
// 必要な環境変数（Supabaseが自動注入）:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 追加で設定する秘密（supabase secrets set ...）:
//   SETTLE_SECRET   … cronからの呼び出し認証用の合言葉（x-settle-secretヘッダと照合）
//   BASHO_DATA_URL  … data/basho.json の公開URL（省略時は下記デフォルト）
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_BASHO_URL = "https://38d95ltszs.github.io/toto-sumo/data/basho.json";

// ---------- クライアントと同じ補助関数 ----------
function hashStr(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}
const ridOf = (name: string) => 100000 + (hashStr("rid::" + name) % 800000);
const round2 = (x: number) => Math.round(x * 100) / 100;
const INT_MAX = 2000000000;
const clampInt = (v: number) => (typeof v === "number" && isFinite(v)) ? Math.max(-INT_MAX, Math.min(INT_MAX, Math.round(v))) : 0;

const ODDS_V2_FROM = "2026-09";
const oddsV2 = (key: string) => String(key || "") >= ODDS_V2_FROM;
const dayBonusOf = (day: number) => (day === 1 || (day >= 8 && day <= 12)) ? 2 : (day >= 13 && day <= 15) ? 3 : 1;
const EW_ODDS = 3;
const KIMARITE_BASE: Record<string, number> = { "押し出し": 2.5, "寄り切り": 2.8, "はたき込み": 3.5, "それ以外": 4.0 };
const SANSHO_ODDS: Record<number, number> = { 8: 2.5, 9: 2.3, 10: 2.1, 11: 1.9, 12: 1.7, 13: 1.5, 14: 1.2 };
const yushoMult = (day: number) => day >= 15 ? 1.5 : 16 - day;

// ---------- 結果データ(basho.json)から精算コンテキストを組む ----------
type Bout = { e: string; w: string; k: string | null; win: "e" | "w" | null; fusen: boolean };
function buildContext(basho: any) {
  const key: string = basho.bashoKey;
  // 有効な番付の力士名だけを対象（クライアントのapplyRealBanzuke/buildSimFromRealと同じフィルタ）
  const validRank = (r: string) => /^([YOSK]|M\d+|J\d+)$/.test(r);
  const names = new Set<string>((basho.banzuke || []).filter((b: any) => validRank(b.rank)).map((b: any) => b.name));
  // 日ごとの取組（力士が番付に居る取組だけ・掲載順を保持）＝ betのboutインデックスの基準
  const days: Record<number, Bout[]> = {};
  const ewCounts: Record<number, { e: number; w: number; complete: boolean }> = {};
  for (let d = 1; d <= 15; d++) {
    const src = (basho.days && (basho.days[String(d)] || basho.days[d])) || null;
    if (!src) continue;
    const bouts: Bout[] = src
      .filter((x: any) => names.has(x.e) && names.has(x.w))
      .map((x: any) => ({ e: x.e, w: x.w, k: x.k ?? null, win: x.win ?? null, fusen: !!x.fusen }));
    days[d] = bouts;
    let e = 0, w = 0, resolved = 0;
    bouts.forEach((b) => { if (b.win) { resolved++; if (b.win === "e") e++; else w++; } });
    ewCounts[d] = { e, w, complete: bouts.length > 0 && resolved === bouts.length };
  }
  const a = basho.awards || {};
  const championName: string | null = a.yusho && a.yusho.name ? a.yusho.name : null;
  const shukun = new Set<string>((a.shukun || []).map((x: any) => x.name));
  const kanto = new Set<string>((a.kanto || []).map((x: any) => x.name));
  const gino = new Set<string>((a.gino || []).map((x: any) => x.name));
  return { key, days, ewCounts, championId: championName ? ridOf(championName) : null, shukun, kanto, gino };
}

// ---------- 1人分の最終持ち米を算出（クライアントの精算と同じ順序・同じ計算） ----------
export function settlePlayer(fs: any, ctx: ReturnType<typeof buildContext>) {
  let points = Number(fs.points) || 0;
  let hits = Number(fs.hitsThisBasho) || 0;
  let bets = Number(fs.betsThisBasho) || 0;
  const v2 = oddsV2(ctx.key);

  // 1) 通常ベット（勝敗＋決まり手）。stakeは賭けた時点で減算済み → 払い戻し分を加算する
  for (const bet of (fs.bets || [])) {
    if (bet.settled) continue;
    const bout = ctx.days[bet.day] ? ctx.days[bet.day][bet.bout] : undefined;
    if (!bout || bout.win == null) { points += (bet.amount || 0) + (bet.kAmount || 0); continue; } // 未確定→返還
    if (bout.fusen) { points += (bet.amount || 0) + (bet.kAmount || 0); continue; } // 不戦→返還
    const hit = bout.win === (bet.side === "east" ? "e" : "w");
    if (hit) { points += Math.round((bet.amount || 0) * (bet.odds || 0)); hits++; }
    if (bet.kimarite && bet.kAmount > 0) {
      const actual = bout.k || "";
      const isOther = !["押し出し", "寄り切り", "はたき込み"].includes(actual);
      const kHit = (bet.kimarite === actual) || (bet.kimarite === "それ以外" && isOther);
      if (kHit) {
        const kOdds = bet.kOdds || (KIMARITE_BASE[bet.kimarite] || 1); // 焼き込み優先
        points += Math.round((bet.kAmount || 0) * kOdds);
      }
    }
  }

  // 2) 東西対抗
  for (const b of (fs.ewBets || [])) {
    if (b.settled) continue;
    const c = ctx.ewCounts[b.day];
    if (!c || !c.complete) { points += (b.amount || 0); continue; } // 不成立→返還
    if (c.e === c.w) { points += (b.amount || 0); continue; } // 引き分け→返還
    const winSide = c.e > c.w ? "east" : "west";
    const bhit = b.side === winSide;
    const margin = Math.abs(c.e - c.w);
    const odds = margin > 0 ? round2(margin * (v2 ? 1 : dayBonusOf(b.day))) : EW_ODDS;
    if (bhit) { points += Math.round((b.amount || 0) * odds); hits++; }
  }

  // 3) 三賞予想（的中賞ごとに現在の持ち米に倍率を重ね掛け）
  if (fs.sanshoBet && !fs.sanshoBet.settled) {
    const sb = fs.sanshoBet;
    const mult = sb.mult || SANSHO_ODDS[sb.day] || 1.2;
    if (sb.amount) points += sb.amount * 3; // 旧・予想料制の返還
    const r = [ctx.shukun.has(sb.shukun), ctx.kanto.has(sb.kanto), ctx.gino.has(sb.gino)];
    r.forEach((h) => { if (h) points += Math.round(points * (mult - 1)); });
  }

  // 4) 優勝予想（三賞まで精算した「千秋楽終了時の持ち米すべて」に倍率）
  if (fs.yushoBet && !fs.yushoBet.settled) {
    const yb = fs.yushoBet;
    const hit = ctx.championId != null && yb.rikishiId === ctx.championId;
    if (hit) {
      if (yb.amount) points += yb.amount;
      const mult = yb.mult || (yb.day ? yushoMult(yb.day) : 2);
      points += Math.round(points * (mult - 1));
    }
  }

  return { finalPoints: clampInt(points), hits: clampInt(hits), bets: clampInt(bets) };
}

// ---------- HTTPハンドラ ----------
Deno.serve(async (req) => {
  // 認証: cronからの合言葉ヘッダを照合（--no-verify-jwt でデプロイする前提）
  const secret = Deno.env.get("94f1TAvqXyQSuRpB22JoLIhnwsBD3kZp");
  if (!secret || req.headers.get("x-settle-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  const bashoUrl = Deno.env.get("https://github.com/38d95ltszs/toto-sumo/blob/main/data/basho.json") || DEFAULT_BASHO_URL;
  let basho: any;
  try {
    const res = await fetch(bashoUrl + "?t=" + Date.now(), { headers: { "cache-control": "no-cache" } });
    if (!res.ok) return json({ error: `basho.json HTTP ${res.status}` }, 502);
    basho = await res.json();
  } catch (e) {
    return json({ error: "basho.json fetch failed: " + String(e) }, 502);
  }
  if (!basho || !basho.bashoKey) return json({ error: "invalid basho.json" }, 400);
  if (!basho.awards || !basho.awards.yusho) return json({ skipped: "awards未発表のため精算しません", bashoKey: basho.bashoKey });

  const ctx = buildContext(basho);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 今場所を戦った全プレイヤーの保存状態を取得
  const { data: rows, error } = await supabase
    .from("player_saves")
    .select("id, full_state")
    .eq("full_state->>bashoKey", basho.bashoKey);
  if (error) return json({ error: "player_saves read failed: " + error.message }, 500);

  let updated = 0;
  const results: any[] = [];
  for (const row of (rows || [])) {
    const fs = row.full_state;
    if (!fs) continue;
    const { finalPoints, hits, bets } = settlePlayer(fs, ctx);
    const { error: upErr } = await supabase
      .from("players")
      .update({ final_points: finalPoints, hits, bets })
      .eq("id", row.id);
    if (!upErr) { updated++; results.push({ id: row.id, finalPoints }); }
    else results.push({ id: row.id, error: upErr.message });
  }

  return json({ ok: true, bashoKey: basho.bashoKey, players: (rows || []).length, updated, results });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
