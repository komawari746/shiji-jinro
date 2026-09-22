/* 指示人狼 サーバー — 依存ライブラリなし。Node 18以上で動きます。
   起動:  node server.js       （既定ポート 3000 / PORT 環境変数で変更可）
   同じWi-Fiにいる7台から  http://<このPCのIP>:3000  を開けば同時プレイできます。 */
const http = require("http");
const fs = require("fs");
const path = require("path");

/* プッシュ通知（web-push）。ライブラリが入っていない場合は、通知機能だけを
   自動的に無効化し、それ以外の機能は通常どおり動かします。
   有効にするには、初回だけ以下を実行してください。
     npm install web-push               */
let webpush = null;
try { webpush = require("web-push"); } catch (e) { /* 未インストールなら通知なしで続行 */ }

const VAPID_FILE = path.join(__dirname, "vapid.json");
let vapidKeys = null;
if (webpush) {
  try { vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); }
  catch (e) {
    vapidKeys = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch (e2) {}
  }
  webpush.setVapidDetails("mailto:example@example.com", vapidKeys.publicKey, vapidKeys.privateKey);
}

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "games.json");
const PLAYER_COUNT = 7, WOLF_COUNT = 2, MAX_DELAY_MS = 5 * 60 * 1000;

/* 市民側にも自然に届く「旅行ログ指示」。今後ここに追加・編集するだけで内容を増やせます。
   kind は、書いてもらう旅行ログの種類(表示の見た目に使う)。
   人狼からの指示と、見た目・届き方はまったく同じにしてあります。 */
const LOG_PROMPTS = [
  { id: "photo_here",   kind: "photo",       text: "今いる場所の写真を1枚撮影して、旅行ログに記録せよ" },
  { id: "photo_duo",    kind: "photo",       text: "一番近くにいる人とツーショットを撮影して、旅行ログに記録せよ" },
  { id: "photo_group",  kind: "photo",       text: "全員が写っている写真を1枚撮影して、旅行ログに記録せよ" },
  { id: "tanka",        kind: "tanka",       text: "今の感情を短歌にして、旅行ログに記録せよ" },
  { id: "photo_request",kind: "photo",       text: "誰か1人に写真を撮ってもらい、旅行ログに記録せよ" },
  { id: "mood",         kind: "mood",        text: "今の気分を5段階で評価して、旅行ログに記録せよ" },
  { id: "poem",         kind: "poem",        text: "ポエムを書いて、旅行ログに記録せよ" },
  { id: "wolf_theory",  kind: "wolf_theory", text: "今の人狼の推理を書いて、旅行ログに記録せよ" }
];
const AMBIENT_INTERVAL = () => rnd(20, 40) * 60 * 1000;   // 20〜40分おき
const MAX_LOG_DELAY_MS = 3 * 60 * 1000;                    // 旅行ログの反映遅延: 最大3分

/* 秘密ミッション。旅行全体で3つだけ、別々のプレイヤーにランダムで届く。
   ここに追加すれば選択肢を増やせる(実際に使うのは毎回3つだけ)。 */
const SECRET_MISSIONS = [
  "みんなへの感謝をラップでまとめて披露しろ（AIを使って作成してもOK）",
  "一発ギャグを10回成功させろ",
  "誰かに「お前今日どうした？」と言わせろ"
];
function assignSecretMissions(g) {
  const shuffledPlayers = g.players.map(p => p.id);
  for (let i = shuffledPlayers.length - 1; i > 0; i--) { const j = rnd(0, i);[shuffledPlayers[i], shuffledPlayers[j]] = [shuffledPlayers[j], shuffledPlayers[i]]; }
  const pool = SECRET_MISSIONS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = rnd(0, i);[pool[i], pool[j]] = [pool[j], pool[i]]; }
  const chosen = shuffledPlayers.slice(0, Math.min(3, pool.length, g.players.length));
  let t = g.createdAt;
  return chosen.map((toId, i) => {
    t = t + (i === 0 ? rnd(30, 90) * 60 * 1000 : rnd(180, 240) * 60 * 1000); // 1個目は30〜90分後、以降は3〜4時間おき
    return { id: uid(), toId, text: pool[i], deliverAt: t, pushed: false, completed: false, rewardPlayerId: null, rewardRole: null };
  });
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const uid = () => Math.random().toString(36).slice(2, 10);

let games = {};
try { games = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA, JSON.stringify(games), () => {}), 400);
}

function newGame(name, names) {
  const roles = Array(PLAYER_COUNT).fill("citizen");
  const idx = [...Array(PLAYER_COUNT).keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = rnd(0, i);[idx[i], idx[j]] = [idx[j], idx[i]]; }
  idx.slice(0, WOLF_COUNT).forEach(i => roles[i] = "wolf");
  const t = Date.now();
  let code; do { code = String(rnd(100000, 999999)); } while (games[code]);
  const g = {
    code, name: name || "旅行", createdAt: t, phase: "playing",
    players: names.map((n, i) => ({
      id: "p" + (i + 1), name: String(n).trim() || ("プレイヤー" + (i + 1)), role: roles[i],
      claimed: false, seenRole: false
    })),
    nextAmbient: t + AMBIENT_INTERVAL(),   // 旅行全体で1本のタイマー(誰か1人にだけ届く)
    orders: [], ambient: [], logs: [], votes: {}, revealedAt: null, secretMissions: []
  };
  g.secretMissions = assignSecretMissions(g);
  return g;
}

function topUp(g) {
  const t = Date.now();
  if (g.phase === "result") return;
  let guard = 0;
  while (g.nextAmbient <= t && guard++ < 5 && g.players.length) {
    const pr = LOG_PROMPTS[rnd(0, LOG_PROMPTS.length - 1)];
    const target = g.players[rnd(0, g.players.length - 1)];
    g.ambient.push({ id: uid(), toId: target.id, text: pr.text, kind: pr.kind, deliverAt: g.nextAmbient, read: false, pushed: false });
    g.nextAmbient = g.nextAmbient + AMBIENT_INTERVAL();
  }
}

function view(g, myId) {
  topUp(g);
  const t = Date.now();
  const me = g.players.find(p => p.id === myId) || null;
  const reveal = g.phase === "result";
  const inbox = [];
  if (me) {
    g.orders.filter(o => o.toId === myId && o.deliverAt <= t)
      .forEach(o => inbox.push({ id: o.id, kind: "order", text: o.text, at: o.deliverAt, read: o.read }));
    g.ambient.filter(a => a.toId === myId && a.deliverAt <= t)
      .forEach(a => inbox.push({ id: a.id, kind: "ambient", promptKind: a.kind, text: a.text, at: a.deliverAt, read: a.read }));
    inbox.sort((a, b) => b.at - a.at);
  }
  let secretMission = null;
  if (me) {
    const sm = (g.secretMissions || []).find(m => m.toId === myId && m.deliverAt <= t);
    if (sm) {
      let reward = null;
      if (sm.completed && sm.rewardPlayerId) {
        const rp = g.players.find(p => p.id === sm.rewardPlayerId);
        if (rp) reward = { name: rp.name, role: rp.role };
      }
      secretMission = { id: sm.id, text: sm.text, completed: sm.completed, reward };
    }
  }
  return {
    code: g.code, name: g.name, phase: g.phase, createdAt: g.createdAt,
    players: g.players.map(p => ({
      id: p.id, name: p.name, claimed: p.claimed,
      role: (reveal || p.id === myId) ? p.role : null, voted: !!g.votes[p.id]
    })),
    me: me ? { id: me.id, name: me.name, role: me.role, seenRole: me.seenRole, pushEnabled: !!me.pushSub } : null,
    inbox,
    secretMission,
    sentCount: me && me.role === "wolf" ? g.orders.filter(o => o.fromId === myId).length : 0,
    logs: g.logs.filter(l => l.playerId === myId || l.deliverAt <= t).slice(-80),
    myVote: g.votes[myId] || null,
    votedCount: Object.keys(g.votes).length,
    reveal: reveal ? {
      orders: g.orders.slice().sort((a, b) => a.deliverAt - b.deliverAt),
      ambientCount: g.ambient.filter(a => a.deliverAt <= t).length,
      votes: g.votes
    } : null
  };
}

function applyAction(g, pid, action, payload) {
  payload = payload || {};
  const me = g.players.find(p => p.id === pid);
  if (action === "seenRole" && me) me.seenRole = true;
  else if (action === "order") {
    if (!me || me.role !== "wolf") return;
    const text = String(payload.text || "").trim().slice(0, 400);
    if (!payload.toId || !text) return;
    const t = Date.now();
    const delay = Math.floor(Math.random() * (MAX_DELAY_MS + 1)); // 0秒〜5分
    g.orders.push({ id: uid(), fromId: pid, toId: payload.toId, text, sentAt: t, deliverAt: t + delay, read: false, pushed: false });
  }
  else if (action === "read") {
    const o = g.orders.find(x => x.id === payload.id && x.toId === pid); if (o) o.read = true;
    const a = g.ambient.find(x => x.id === payload.id && x.toId === pid); if (a) a.read = true;
  }
  else if (action === "log") {
    const txt = String(payload.text || "").trim().slice(0, 600);
    const photo = (typeof payload.photo === "string" && payload.photo.startsWith("data:image/")) ? payload.photo : null;
    const allowedKinds = ["free", "photo", "tanka", "poem", "mood", "wolf_theory"];
    const kind = allowedKinds.includes(payload.kind) ? payload.kind : "free";
    let mood = null;
    if (kind === "mood") { const m = parseInt(payload.mood, 10); if (m >= 1 && m <= 5) mood = m; }
    if (!txt && !photo && !mood) return;
    const t = Date.now();
    const delay = Math.floor(Math.random() * (MAX_LOG_DELAY_MS + 1));  // 0分〜3分
    g.logs.push({ id: uid(), playerId: pid, kind, text: txt, photo, mood, at: t, deliverAt: t + delay });
  }
  else if (action === "openVote") { if (g.phase === "playing") g.phase = "voting"; }
  else if (action === "vote") {
    if (g.phase !== "voting") return;
    const v = (payload.picks || []).slice(0, 2);
    if (v.length === 2) g.votes[pid] = v;
  }
  else if (action === "missionComplete") {
    const sm = (g.secretMissions || []).find(m => m.toId === pid && m.deliverAt <= Date.now());
    if (!sm || sm.completed) return;
    sm.completed = true;
    const others = g.players.filter(p => p.id !== pid);
    if (others.length) {
      const target = others[rnd(0, others.length - 1)];
      sm.rewardPlayerId = target.id;
      sm.rewardRole = target.role;
    }
  }
  else if (action === "reveal") { g.phase = "result"; g.revealedAt = Date.now(); }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch (e) { r({}); } }); });
}

/* 通知が届いたタイミングで、対象プレイヤーの端末へプッシュ通知を送る。
   人狼の指示か、市民への自動通知かは、この通知の文面からは絶対に分からない
   ようにする(両方とも同じ文面)。 */
function pushLoop() {
  if (!webpush) return;
  const t = Date.now();
  Object.values(games).forEach(g => {
    topUp(g);
    const items = [...g.orders, ...g.ambient, ...(g.secretMissions || [])].filter(x => x.deliverAt <= t && !x.pushed);
    items.forEach(async it => {
      it.pushed = true;
      const pl = g.players.find(p => p.id === it.toId);
      if (!pl || !pl.pushSub) return;
      const payload = JSON.stringify({ title: "あなたへの指示があります", body: "タップして確認してください" });
      try { await webpush.sendNotification(pl.pushSub, payload); }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) pl.pushSub = null; }
    });
  });
  save();
}
if (webpush) setInterval(pushLoop, 5000);

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === "/api/ping") return json(res, 200, { ok: true, push: !!webpush });

  if (p === "/api/vapidPublicKey") {
    if (!webpush) return json(res, 200, { key: null });
    return json(res, 200, { key: vapidKeys.publicKey });
  }

  if (p === "/api/subscribe" && req.method === "POST") {
    if (!webpush) return json(res, 200, { ok: false, reason: "push_unavailable" });
    const b = await body(req);
    const g = games[b.code]; if (!g) return json(res, 404, { error: "not_found" });
    const pl = g.players.find(x => x.id === b.pid); if (!pl) return json(res, 404, { error: "no_player" });
    pl.pushSub = b.subscription || null; save();
    return json(res, 200, { ok: true });
  }

  if (p === "/api/exists") return json(res, 200, { exists: !!games[u.searchParams.get("code")] });

  if (p === "/api/state") {
    const g = games[u.searchParams.get("code")];
    if (!g) return json(res, 404, { error: "not_found" });
    const out = view(g, u.searchParams.get("pid"));
    save();
    return json(res, 200, out);
  }

  if (p === "/api/create" && req.method === "POST") {
    const b = await body(req);
    const names = Array.isArray(b.names) ? b.names.slice(0, PLAYER_COUNT) : [];
    if (names.length !== PLAYER_COUNT) return json(res, 400, { error: "need_7_names" });
    const g = newGame(b.name, names);
    games[g.code] = g; save();
    return json(res, 200, { code: g.code });
  }

  if (p === "/api/claim" && req.method === "POST") {
    const b = await body(req);
    const g = games[b.code]; if (!g) return json(res, 404, { error: "not_found" });
    const pl = g.players.find(x => x.id === b.pid); if (!pl) return json(res, 404, { error: "no_player" });
    pl.claimed = true; save();
    return json(res, 200, { token: pl.id });
  }

  if (p === "/api/act" && req.method === "POST") {
    const b = await body(req);
    const g = games[b.code]; if (!g) return json(res, 404, { error: "not_found" });
    applyAction(g, b.pid, b.action, b.payload);
    const out = view(g, b.pid); save();
    return json(res, 200, out);
  }

  // 静的ファイル
  const file = p === "/" ? "/index.html" : p;
  const fp = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(fp);
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".json" ? "application/json" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}).listen(PORT, () => {
  const os = require("os");
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
  console.log("指示人狼サーバー起動");
  console.log("  この端末:  http://localhost:" + PORT);
  ips.forEach(ip => console.log("  同じWi-Fi: http://" + ip + ":" + PORT));
});
