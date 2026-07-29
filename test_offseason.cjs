// 番付予想モード・総合発表・オフシーズンタブの統合テスト（jsdom）
// 2026年カレンダー: 7月場所 7/12初日・7/26千秋楽・7/29(水)総合発表
//                  9月場所 9/13初日・8/31(月)番付発表・予想締切8/30
const { JSDOM } = require("/tmp/node_modules/jsdom");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✓", label); }
  else { fail++; console.log("  ✗ FAIL:", label); }
}

// 実データのモック（前=7月場所の幕内番付 / nextBanzuke=9月場所の新番付）
const ROSTER = [
  ["豊昇龍","Y","E"],["大の里","Y","W"],["霧島","O","E"],["琴櫻","O","W"],
  ["熱海富士","S","E"],["琴勝峰","S","W"],["若隆景","S","E"],["安青錦","S","W"],
  ["義ノ富士","K","E"],["王鵬","K","W"],
  ["藤ノ川","M1","E"],["隆の勝","M1","W"],["豪ノ山","M2","E"],["美ノ海","M2","W"],
  ["平戸海","M3","E"],["伯乃富士","M3","W"],["大栄翔","M4","E"],["一山本","M4","W"],
  ["宇良","M5","E"],["玉鷲","M5","W"],["翔猿","M6","E"],["高安","M6","W"],
];
const mkBanzuke = () => ROSTER.map(([name, rank, side]) => ({ name, rank, side }));
// 9月場所の新番付（answer）: 関脇が2人に減り、前頭が繰り上がる等の変動を入れる
const NEXT_LIST = [
  ["豊昇龍","Y","東"],["大の里","Y","西"],["霧島","O","東"],["琴櫻","O","西"],
  ["安青錦","S","東"],["熱海富士","S","西"],
  ["王鵬","K","東"],["義ノ富士","K","西"],
  ["若隆景","M1","東"],["琴勝峰","M1","西"],
  ["藤ノ川","M2","東"],["隆の勝","M2","西"],
  ["豪ノ山","M3","東"],["平戸海","M3","西"],
  ["美ノ海","M4","東"],["大栄翔","M4","西"],
  ["伯乃富士","M5","東"],["一山本","M5","西"],
].map(([name, rank, side]) => ({ name, rank, side }));

function realJson(withNext) {
  const j = { bashoKey: "2026-07", banzuke: mkBanzuke(), days: { "1": [] }, awards: { yusho: { name: "豊昇龍" } } };
  if (withNext) j.nextBanzuke = { bashoKey: "2026-09", list: NEXT_LIST };
  return j;
}

function makeDom({ jstIso, gameState, real }) {
  // jstIso 例 "2026-08-05T12:00" (JST)
  const [d, t] = jstIso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const nowMs = Date.UTC(Y, M - 1, D, h - 9, mi);
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.com/",
    beforeParse(window) {
      window.Date.now = () => nowMs;
      window.fetch = async url => {
        if (String(url).includes("basho.json") && real) {
          return { ok: true, json: async () => real };
        }
        return { ok: false, status: 404 };
      };
      if (gameState) window.localStorage.setItem("gameState", JSON.stringify(gameState));
      window.confirm = () => true;
      window.HTMLCanvasElement.prototype.getContext = () => null;
    }
  });
  return dom;
}
const settle = () => new Promise(r => setTimeout(r, 250));

function baseState(extra) {
  return Object.assign({
    profile: { shikona: "試験力士", ichimon: "出羽海", oshiName: "豊昇龍", oshiId: 1, title: "t1_01", comment: "" },
    points: 42000, achievements: ["t1_01"], stats: {}, bashoCount: 1, banzukeLevel: 3,
    bashoKey: "2026-07", bets: [], ewBets: [], dayAgg: {}, yushoBet: null, sanshoBet: null,
    pointsHistory: [], dayLog: [], betDays: [1], hitsThisBasho: 3, betsThisBasho: 5,
    finishedProcessed: true, finalPoints: 42000, banzukeAnnounced: false,
    lastResult: { bashoName: "令和8年七月場所", champion: "豊昇龍", championWins: 13, playoff: false,
      shukun: "王鵬", kanto: "安青錦", gino: "若隆景", yushoResult: null, sanshoResult: null,
      finalPoints: 42000, hits: 3, bets: 5, banzuke: null, kg: 100, tawara: 1.7, yen: 60000,
      ichimonWin: false, topIchimon: "出羽海" },
    quizToday: { date: "", count: 0 }, answeredQuiz: [], quizCatCorrect: {}, acctPromptShown: true
  }, extra);
}

(async () => {
  console.log("=== A. オフシーズンの新規ユーザー（8/5・予想受付中）===");
  {
    const dom = makeDom({ jstIso: "2026-08-05T12:00", gameState: null, real: realJson(false) });
    const w = dom.window;
    await settle();
    // オンボーディング後の状態を再現
    w.newGame("新弟子太郎", "出羽海", "豊昇龍", "");
    await w.ensureBashoState();
    w.renderAll();
    const navLabels = [...w.document.querySelectorAll("nav button")].map(b => b.textContent);
    ok(JSON.stringify(navLabels) === JSON.stringify(["総合発表", "番付予想", "米取表"]), "オフシーズンのタブ構成: " + navLabels.join("|"));
    ok(w.eval('UI.tab') === "sougou", "既定タブがsougouに正規化される");
    ok(w.document.getElementById("tab-sougou").textContent.includes("来場所が初土俵"), "新規ユーザーに「来場所が初土俵！」表示");
    ok(!w.document.getElementById("tab-sougou").textContent.includes("編成会議の発表はありません") === false, "編成会議の結果なし文言");
    // 番付予想タブ: フォームが開いている
    w.gotoTab("yosou");
    const yhtml = w.document.getElementById("tab-yosou").innerHTML;
    ok(yhtml.includes("この内容で確定する"), "予想フォームが受付中");
    ok(w.eval('G.banzukePrediction && G.banzukePrediction.forBashoKey') === "2026-09", "予想の入れ物が9月場所向けに作成される");
    ok((yhtml.match(/<select/g) || []).length === 16, "スロットが16枠");
    ok(yhtml.includes("8月30日(日)"), "締切表示が8月30日(日)");
    // 前場所の在位人数が初期値になる（モックの前場所は関脇4人）
    ok(w.eval('G.banzukePrediction.counts.sekiwake') === 4, "関脇の初期人数=前場所の在位4人");
    // 三役の増減: 関脇は既に上限4 → 増やしても変化なし（三役10人+前頭6=最後は西前頭3枚目）
    w.onYosouCount("sekiwake", 1);
    const slots = w.eval('yosouAllSlots(G.banzukePrediction.counts)');
    ok(slots.length === 16, "上限到達後も合計16枠");
    ok(slots[slots.length - 1].label === "西前頭3枚目", "三役10人時は最後が西前頭3枚目: " + slots[slots.length - 1].label);
    // 横綱を1人に減らせる → 前頭側が1枠広がる
    w.onYosouCount("yokozuna", -1);
    ok(w.eval('G.banzukePrediction.counts.yokozuna') === 1, "横綱を1人に減らせる");
    const slots2 = w.eval('yosouAllSlots(G.banzukePrediction.counts)');
    ok(slots2[slots2.length - 1].label === "東前頭4枚目", "横綱1人時は東前頭4枚目まで広がる: " + slots2[slots2.length - 1].label);
    w.onYosouCount("yokozuna", 1);
    // 関脇を2人まで減らすと前頭5枚目まで広がる
    w.onYosouCount("sekiwake", -1); w.onYosouCount("sekiwake", -1);
    const slots3 = w.eval('yosouAllSlots(G.banzukePrediction.counts)');
    ok(slots3[slots3.length - 1].label === "西前頭4枚目", "関脇2人時は西前頭4枚目まで: " + slots3[slots3.length - 1].label);
    // 選択と確定
    w.onYosouSelect("yokozuna-slot0", "豊昇龍");
    w.onYosouConfirm();
    ok(w.eval('G.banzukePrediction.confirmed') === true, "確定できる");
    w.renderYosou();
    ok(w.document.getElementById("tab-yosou").innerHTML.includes("編集に戻る"), "確定後も編集に戻れる");
    w.onYosouEdit();
    ok(w.eval('G.banzukePrediction.confirmed') === false, "編集に戻すと再修正できる");
  }

  console.log("=== B. 千秋楽後〜編成会議前（7/27）===");
  {
    const dom = makeDom({ jstIso: "2026-07-27T12:00", gameState: baseState(), real: realJson(false) });
    const w = dom.window;
    await settle();
    const navLabels = [...w.document.querySelectorAll("nav button")].map(b => b.textContent);
    ok(navLabels[0] === "総合発表", "打ち止め後はオフシーズンタブ");
    ok(w.eval('G.banzukeAnnounced') === false, "編成会議はまだ（水曜前）");
    const s = w.document.getElementById("tab-sougou").textContent;
    ok(s.includes("7月29日(水)") && s.includes("10:00"), "編成会議の日時を予告");
    ok(s.includes("凍結"), "凍結中の案内");
    w.gotoTab("yosou");
    ok(w.document.getElementById("tab-yosou").textContent.includes("総合発表"), "番付予想はまだ受付前");
    ok(!w.eval('G.banzukePrediction'), "受付前は予想の入れ物を作らない");
  }

  console.log("=== C. 編成会議後（7/30）: 番付確定と持ち米リセット ===");
  {
    const dom = makeDom({ jstIso: "2026-07-30T12:00", gameState: baseState(), real: realJson(false) });
    const w = dom.window;
    await settle();
    ok(w.eval('G.banzukeAnnounced') === true, "編成会議が実行される");
    ok(w.eval('G.banzukeLevel') >= 4, "新弟子には戻らない(level=" + w.eval('G.banzukeLevel') + ")");
    const expected = 15000 + w.eval('kaigiBonusOf(G.banzukeLevel)');
    ok(w.eval('G.points') === expected, `持ち米が15000+ボーナスにリセット: ${w.eval('G.points')} === ${expected}`);
    ok(w.eval('G.lastKaigi && G.lastKaigi.prevLevel') === 3, "変動前の番付を記録");
    w.gotoTab("sougou");
    const s = w.document.getElementById("tab-sougou").textContent;
    ok(s.includes("トト番付編成会議の結果"), "総合発表に編成会議の結果");
    ok(s.includes("大相撲の正式な番付発表は本場所の2週間前の月曜日"), "正式発表の注記");
    ok(s.includes("番付予想モード 受付中"), "番付予想の案内バナー");
    // 42000合(≥33000)のソロプレイヤーはトト綱 → +15000 → 30000
    ok(w.eval('G.points') === 30000, "トト綱ボーナス15000で30000合スタート: " + w.eval('G.points'));
  }

  console.log("=== D. 番付発表後（8/31）: 答え合わせとボーナス加算 ===");
  {
    // 14問正解・2ミスになる予想（若隆景・琴勝峰のM1入れ替わりを外す）
    const counts = { yokozuna: 2, ozeki: 2, sekiwake: 2, komusubi: 2 };
    const slots = {
      "yokozuna-slot0": "豊昇龍", "yokozuna-slot1": "大の里",
      "ozeki-slot0": "霧島", "ozeki-slot1": "琴櫻",
      "sekiwake-slot0": "安青錦", "sekiwake-slot1": "熱海富士",
      "komusubi-slot0": "王鵬", "komusubi-slot1": "義ノ富士",
      "maegashira1-東": "宇良", "maegashira1-西": "高安",   // ← 不正解(正解は若隆景・琴勝峰)
      "maegashira2-東": "藤ノ川", "maegashira2-西": "隆の勝",
      "maegashira3-東": "豪ノ山", "maegashira3-西": "平戸海",
      "maegashira4-東": "美ノ海", "maegashira4-西": "大栄翔",
    };
    const st = baseState({
      banzukeAnnounced: true, points: 30000, banzukeLevel: 9,
      lastKaigi: { prevLevel: 3, newLevel: 9, bonus: 15000, bashoKey: "2026-07" },
      banzukePrediction: { forBashoKey: "2026-09", counts, slots, confirmed: true, graded: false, result: null, detail: null }
    });
    const dom = makeDom({ jstIso: "2026-08-31T12:00", gameState: st, real: realJson(true) });
    const w = dom.window;
    await settle();
    const p = w.eval('G.banzukePrediction');
    ok(p.graded === true, "採点が実行される");
    ok(p.result && p.result.correct === 14, "14問的中: " + (p.result && p.result.correct));
    ok(p.result.bonus === 14000, "2ミス→ボーナス14000: " + p.result.bonus);
    ok(w.eval('G.points') === 44000, "持ち米に加算 30000+14000=44000: " + w.eval('G.points'));
    w.gotoTab("yosou");
    const y = w.document.getElementById("tab-yosou").textContent;
    ok(y.includes("14 / 16 問的中"), "結果表示");
    ok(y.includes("若隆景"), "正解の答え合わせ表示");
    w.gotoTab("sougou");
    ok(w.document.getElementById("tab-sougou").textContent.includes("答え合わせ済み"), "総合発表にも結果サマリ");
  }

  console.log("=== E. 締切後・発表待ち（8/31 0:30・データ未着）===");
  {
    const st = baseState({
      banzukeAnnounced: true, points: 30000, banzukeLevel: 9,
      banzukePrediction: { forBashoKey: "2026-09", counts: { yokozuna: 2, ozeki: 2, sekiwake: 2, komusubi: 2 }, slots: { "yokozuna-slot0": "豊昇龍" }, confirmed: true, graded: false, result: null, detail: null }
    });
    const dom = makeDom({ jstIso: "2026-08-31T00:30", gameState: st, real: realJson(false) });
    const w = dom.window;
    await settle();
    ok(w.eval('G.banzukePrediction.graded') === false, "データ未着なら採点は保留");
    ok(w.eval('G.points') === 30000, "持ち米は未加算");
    w.gotoTab("yosou");
    const y = w.document.getElementById("tab-yosou").textContent;
    ok(y.includes("締め切りました"), "締切後は修正不可の表示");
    w.onYosouEdit();
    ok(w.eval('G.banzukePrediction.confirmed') === true, "締切後は編集に戻れない");
  }

  console.log("=== F. 本場所中はタブが従来どおり（9/14・2日目）===");
  {
    const st = baseState({
      bashoKey: null, finishedProcessed: false, banzukeAnnounced: true, points: 30000, banzukeLevel: 9,
      lastResult: null
    });
    const dom = makeDom({ jstIso: "2026-09-14T12:00", gameState: st, real: null });
    const w = dom.window;
    await settle();
    const navLabels = [...w.document.querySelectorAll("nav button")].map(b => b.textContent);
    ok(JSON.stringify(navLabels) === JSON.stringify(["取組予想", "場所予想", "米取表"]), "本場所中のタブ構成: " + navLabels.join("|"));
    ok(w.eval('UI.tab') === "torikumi", "既定タブはtorikumi");
    ok(w.eval('G.bashoKey') === "2026-09", "9月場所に参加");
  }

  console.log(`\n結果: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
