# CLAUDE.md — トト相撲 ONLINE 開発メモ（Claude Code用）

このファイルはリポジトリ直下に置くこと。Claude Codeが毎回自動で読み込み、プロジェクトの前提・注意点を引き継ぐ。

## プロジェクト概要

大相撲の取組を予想して架空通貨「持ち米」を賭ける、ブラウザ完結のファンメイド予想ゲーム。
- 本体は **単一HTMLファイル `index.html`**（HTML/CSS/JSを1ファイルに集約・フレームワーク不使用）。
- ホスティング：GitHub Pages。バックエンド：Supabase（Auth＋Postgres）。
- 詳細仕様は **`ゲーム仕様書.md`** を参照（機能・番付・オフシーズン・オッズ等の基準ドキュメント）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | ゲーム本体（唯一の実行ファイル） |
| `data/basho.json` | その場所の実データ（番付・取組結果・優勝三賞・ニュース）。1場所につき1ファイルを上書き運用 |
| `scraper/fetch_basho.mjs` | ニュース見出しだけをGoogleニュースRSSから取得（それ以外は手動） |
| `.github/workflows/update-data.yml` | 上記を1日5回実行（ニュースのみ更新） |
| `.github/workflows/settle-basho.yml` | サーバー精算Edge Functionを毎朝呼ぶcron |
| `supabase/functions/settle-basho/index.ts` | サーバー側の強制精算（オフシーズン中に全員のfinal_pointsを確定） |
| `取組結果登録ツール.html` | 番付・取組結果・優勝三賞を手動登録して basho.json を作る管理ツール（公開不要・手元で使用） |
| `ゲーム仕様書.md` ほか各 `.md` | 仕様・手順・設計メモ |

## 運用（手動データ登録）

- 取組・番付・優勝三賞は **自動スクレイピングしない**。運営が `取組結果登録ツール.html` で公開情報（相撲レファレンス／ABEMA／スポナビ）をコピペ登録し、`data/basho.json` を作って上書きコミットする。
- ニュース見出しのみ自動（Googleニュースの公開RSS）。
- 過去の場所の記録はファイルではなく Supabase の `basho_results` に自動保存される。basho.jsonは今の場所専用の作業ファイル。

## ⚠️ 絶対に守る注意点（不変条件）

1. **精算ロジックは2箇所にある**：`index.html` の `settlePending`/`processFinish` と、`supabase/functions/settle-basho/index.ts` の `settlePlayer`。オッズやボーナス、優勝/三賞の倍付けなど精算に関わるルールを変えたら、**必ず両方**を直して整合させる（片方だけ直すと番付が壊れる）。
2. **オッズの倍付けは冪等に**：優勝・三賞の倍付けは `yushoBet.settled` / `sanshoBet.settled` フラグで一度だけ適用する。再適用させると持ち米が指数的に膨張する（過去に106億まで膨張する事故があった。詳細 `持ち米インフレ対策メモ.md`）。
3. **オッズ倍付けの新旧切替**：`ODDS_V2_FROM = "2026-09"` で切り替わる（場所キー比較）。進行中の場所には遡及させない。現行(新体系)の倍率＝一門×1.2 / 推し×1.2 / 初白星×1.3 / 勝ち越し王手×1.3 / 休場明け×2 / 懸賞一番×2。
4. **持ち米はinteger範囲(±約21億)にクランプしてから同期**（`pglayers.points`はinteger）。異常値対策の安全弁として残す。
5. **秘密情報をリポジトリに置かない**：Supabaseの `service_role` キー、`SETTLE_SECRET` はSupabase Secrets／GitHub Secretsにのみ。`index.html` に入っている Supabase anon キーは公開前提でOK。
6. **モバイル(iOS/WebKit)配慮**：`getContext("2d")` はnullを返し得るのでnullガード必須。数値をループに使う箇所（グラフの目盛り等）は異常値でも暴走しない上限を設ける。

## 変更後の検証

`index.html` はブラウザ実行前提だが、ロジック検証は **jsdom** で行える（このプロジェクトの標準手順）。
- スクリプトを取り出して `new Function` で構文チェック。
- `jsdom` で `window` を作り、`Date.now`・`fetch`・`localStorage`・`getContext` をモックして関数を実行し、結果をアサートする。
- サーバー精算(`settlePlayer`)を変えたら、同じ入力でクライアントの `processFinish` と `final_points` が一致するか必ず突き合わせる。

## デプロイ

- 本体：`index.html`（＋必要な `data/`, `scraper/`, `.github/`）をGitHub Pagesのリポジトリにコミット／プッシュ。
- Edge Function：`supabase functions deploy settle-basho --no-verify-jwt`（認証は `x-settle-secret` ヘッダで実施）。
- セットアップ全体は `セットアップ手順.md`、サーバー精算は `サーバー精算_設定手順.md`。

## 現状メモ（2026-07時点）

- 令和8年七月場所を手動運用で実施。過去の倍付けバグで持ち米が膨張したテスト/友人口座が数件あるが、「それも今場所の結果」として残す判断（運営了承済み）。冪等化済みなので次場所以降は再発しない。
- サーバー強制精算(Edge Function＋cron)は稼働確認済み。
