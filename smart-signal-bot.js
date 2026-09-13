/**
 * PUMP.FUN AKILLI CÜZDAN + HIZ SİNYAL BOTU
 * =======================================================
 * MİMARİ:
 *   PumpPortal WS (ücretsiz, canlı veri) -> kendi kendine öğrenen cüzdan skorlama
 *   -> "akıllı cüzdan + hız" sinyali -> Telegram (sen manuel karar verirsin)
 *
 * BU BOT OTOMATİK ALIM-SATIM YAPMAZ. Sadece sinyal atar, sen /onayla ile
 * takibe alırsın, bot fiyatı arka planda izleyip 2x/5x/10x/20x'e ulaştıkça
 * haber verir. Böylece gerçek para koymadan stratejiyi haftalarca test edebilirsin.
 *
 * NASIL "AKILLI CÜZDAN" BULUR (dış ücretli API yok, tamamen ücretsiz):
 *   1) Her yeni token'ın ilk ~90 saniyesindeki alıcılarını kaydeder.
 *   2) Token'ın kaderi belli olunca (öldü ya da 24 saat doldu), zirve/başlangıç
 *      oranına bakar: 3x+ yapmışsa o erken alıcılar "kazanan" sayılır.
 *   3) 12 saatte bir, kazanma oranı yüksek cüzdanlardan "akıllı cüzdan listesi"
 *      çıkarır ve gerçek zamanlı sinyal üretiminde bu listeyi kullanır.
 *   NOT: Bot ilk 24-48 saat veri toplarken liste küçük/boş olur, sinyaller
 *   seyrek gelir. Bu normaldir — veri biriktikçe kalite artar.
 *
 * TELEGRAM KOMUTLARI:
 *   /durum     -> bot durumu, izlenen token, akıllı cüzdan sayısı
 *   /liste     -> en iyi akıllı cüzdanlar (kısa özet)
 *   /sinyaller -> son sinyaller ve (varsa) sonuçları
 *   /onayla <mint_önek>  -> bir sinyali takibe al (checkpoint bildirimleri için)
 *   /durdur    -> yeni sinyal üretmeyi durdurur (izleme/öğrenme devam eder)
 *   /baslat    -> tekrar aktif eder
 *   /ayarlar   -> aktif eşik ve limitleri gösterir
 *
 * GEREKLİ ORTAM DEĞİŞKENLERİ:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (aynı bot.js'teki gibi @BotFather / @userinfobot)
 */

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ====================== AYARLAR ======================
const CONFIG = {
  EARLY_WINDOW_SEC: 90,          // ilk kaç saniyedeki alımlar "erken alıcı" sayılır
  MIN_LAUNCH_BUY_SOL: 0.05,      // bu kadar altı kurucu alımı olan token hiç izlenmez (gürültü azaltma)
  MAX_TRACKED_TOKENS: 400,       // aynı anda izlenen maksimum token (bellek/abonelik koruması)
  TRACK_WINDOW_HOURS: 24,        // bir token en fazla bu kadar süre izlenip sonuçlandırılır
  DEAD_AFTER_MIN: 120,           // bu kadar dakika işlem görmeyen token "öldü" sayılır
  WIN_MULTIPLE: 3,               // peak/başlangıç oranı bunun üstündeyse "kazanan" token

  MINE_INTERVAL_HOURS: 12,       // akıllı cüzdan listesi kaç saatte bir yeniden hesaplanır
  MIN_WINS_FOR_SMART: 2,         // akıllı sayılmak için en az bu kadar kazanan erken yakalama
  MIN_WINRATE_FOR_SMART: 0.4,    // ve en az bu kazanma oranı
  MAX_SMART_WALLETS: 150,

  MIN_SMART_BUYERS_FOR_SIGNAL: 2,  // sinyal için en az bu kadar akıllı cüzdan aynı token'ı almış olmalı
  VELOCITY_WINDOW_MIN: 3,          // hız hesap penceresi (dakika)
  VELOCITY_THRESHOLD_PCT: 80,      // bu pencerede %80+ mcap artışı = "hızlı çıkıyor"
  MIN_SIGNAL_AGE_SEC: 20,           // token bu yaştan önce sinyal atılmaz

  CHECKPOINTS: [2, 5, 10, 20],      // /onayla sonrası bildirim eşikleri (x)

  PERSIST_INTERVAL_SEC: 60,
  SWEEP_INTERVAL_SEC: 300,
  PORT: parseInt(process.env.PORT || "3000", 10),
};
// =====================================================

const DB_FILE = path.join(__dirname, "smart-signal-data.json");

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      walletStats: raw.walletStats || {},
      smartWallets: raw.smartWallets || [],
      signalHistory: raw.signalHistory || [],
      approved: raw.approved || {},
      lastMinedAt: raw.lastMinedAt || 0,
    };
  } catch {
    return { walletStats: {}, smartWallets: [], signalHistory: [], approved: {}, lastMinedAt: 0 };
  }
}

function saveDb(db) {
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { log("DB", "Kaydetme hatası: " + e.message); }
}

const db = loadDb();
let smartWalletSet = new Set(db.smartWallets.map((w) => w.wallet));
let dirty = false;
function markDirty() { dirty = true; }

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const state = {
  active: true,
  startedAt: Date.now(),
  tracked: new Map(),   // mint -> token izleme kaydı
  signalsToday: 0,
};

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

// ---------- SAĞLIK SUNUCUSU ----------
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `Sinyal botu ayakta | izlenen token: ${state.tracked.size} | akilli cuzdan: ${smartWalletSet.size}`
  );
}).listen(CONFIG.PORT, () => log("HTTP", `Sağlık sunucusu port ${CONFIG.PORT}'da`));

// ---------- TELEGRAM ----------
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { log("TG", "Mesaj gönderilemedi: " + e.message); }
}

let tgOffset = 0;
async function tgPollCommands() {
  if (TG_TOKEN) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${tgOffset}&timeout=25`
      );
      const data = await res.json();
      for (const upd of data.result || []) {
        tgOffset = upd.update_id + 1;
        const text = upd.message?.text?.trim();
        const from = String(upd.message?.chat?.id || "");
        if (!text || from !== String(TG_CHAT)) continue;
        await handleCommand(text);
      }
    } catch (e) { /* sessizce yeniden dene */ }
  }
  setTimeout(tgPollCommands, 1000);
}

async function handleCommand(rawText) {
  const text = rawText.toLowerCase();
  if (text === "/durum" || text === "/status") {
    const uptimeMin = Math.floor((Date.now() - state.startedAt) / 60000);
    await tgSend(
      `📊 <b>SİNYAL BOTU DURUMU</b>\n` +
      `Aktif: ${state.active ? "✅" : "⏸"}\n` +
      `İzlenen token: ${state.tracked.size}/${CONFIG.MAX_TRACKED_TOKENS}\n` +
      `Akıllı cüzdan: ${smartWalletSet.size} (toplam ölçülen: ${Object.keys(db.walletStats).length})\n` +
      `Son liste güncelleme: ${db.lastMinedAt ? new Date(db.lastMinedAt).toISOString().slice(0, 16).replace("T", " ") : "henüz yok"}\n` +
      `Bugünkü sinyal: ${state.signalsToday}\n` +
      `Takip edilen onaylı sinyal: ${Object.keys(db.approved).length}\n` +
      `Çalışma süresi: ${uptimeMin} dk`
    );
  } else if (text === "/liste") {
    if (!db.smartWallets.length) {
      await tgSend("Henüz akıllı cüzdan listesi yok — bot veri topluyor, ilk liste 12 saat içinde çıkar.");
      return;
    }
    const top = db.smartWallets.slice(0, 10)
      .map((w, i) => `${i + 1}. <code>${w.wallet.slice(0, 6)}…</code> — ${w.wins}/${w.total} kazanç, ort. ${w.avgMultiple.toFixed(2)}x`)
      .join("\n");
    await tgSend(`🧠 <b>EN İYİ AKILLI CÜZDANLAR</b>\n${top}`);
  } else if (text === "/sinyaller") {
    if (!db.signalHistory.length) { await tgSend("Henüz sinyal atılmadı."); return; }
    const list = db.signalHistory.slice(0, 10)
      .map((s) => `• ${s.symbol} — 👥${s.smartCount} ⚡%${s.velocity} — <code>${s.mint.slice(0, 8)}</code>`)
      .join("\n");
    await tgSend(`📡 <b>SON SİNYALLER</b>\n${list}`);
  } else if (text.startsWith("/onayla")) {
    const parts = rawText.split(/\s+/);
    const prefix = parts[1];
    if (!prefix) { await tgSend("Kullanım: /onayla <mint önek> — mint'i /sinyaller'den kopyala."); return; }
    const found = db.signalHistory.find((s) => s.mint.startsWith(prefix));
    if (!found) { await tgSend("Bu önekle eşleşen sinyal bulunamadı. /sinyaller ile kontrol et."); return; }
    db.approved[found.mint] = { symbol: found.symbol, entryMC: found.entryMC, approvedAt: Date.now(), notified: [] };
    markDirty();
    await tgSend(`✅ ${found.symbol} takibe alındı. 2x/5x/10x/20x'e ulaştıkça haber vereceğim.`);
  } else if (text === "/durdur" || text === "/stop") {
    state.active = false;
    await tgSend("⏸ Yeni sinyal üretimi durduruldu. Cüzdan öğrenme ve izleme devam ediyor.");
  } else if (text === "/baslat" || text === "/start") {
    state.active = true;
    await tgSend("▶️ Sinyal üretimi tekrar aktif.");
  } else if (text === "/ayarlar") {
    await tgSend(
      `⚙️ <b>AYARLAR</b>\n` +
      `Sinyal eşiği: ${CONFIG.MIN_SMART_BUYERS_FOR_SIGNAL}+ akıllı cüzdan VEYA %${CONFIG.VELOCITY_THRESHOLD_PCT} hız (${CONFIG.VELOCITY_WINDOW_MIN}dk)\n` +
      `Akıllı cüzdan kriteri: ${CONFIG.MIN_WINS_FOR_SMART}+ kazanç, %${Math.round(CONFIG.MIN_WINRATE_FOR_SMART * 100)}+ kazanma oranı\n` +
      `Kazanan token tanımı: başlangıca göre ${CONFIG.WIN_MULTIPLE}x+\n` +
      `Liste güncelleme: ${CONFIG.MINE_INTERVAL_HOURS} saatte bir\n` +
      `Maks izlenen token: ${CONFIG.MAX_TRACKED_TOKENS}`
    );
  } else if (text === "/yardim" || text === "/help") {
    await tgSend(
      `📋 <b>KOMUTLAR</b>\n/durum /liste /sinyaller\n/onayla <mint önek>\n/durdur /baslat /ayarlar`
    );
  }
}

// ---------- HIZ HESABI ----------
function calcVelocityPct(tok) {
  const now = Date.now();
  const windowMs = CONFIG.VELOCITY_WINDOW_MIN * 60000;
  let past = tok.mcHistory[0];
  for (const p of tok.mcHistory) { if (now - p.t >= windowMs) past = p; else break; }
  if (!past || past.mc <= 0) return 0;
  return ((tok.peakMC - past.mc) / past.mc) * 100;
}

// ---------- SİNYAL ----------
async function maybeSignal(tok) {
  if (tok.signaled || !state.active) return;
  const ageSec = (Date.now() - tok.launchTime) / 1000;
  if (ageSec < CONFIG.MIN_SIGNAL_AGE_SEC) return;
  const velocity = calcVelocityPct(tok);
  const smartCount = tok.smartBuyers.size;
  if (smartCount >= CONFIG.MIN_SMART_BUYERS_FOR_SIGNAL || velocity >= CONFIG.VELOCITY_THRESHOLD_PCT) {
    tok.signaled = true;
    state.signalsToday++;
    const starsN = Math.max(1, Math.min(3, smartCount + (velocity > 150 ? 1 : 0)));
    const stars = "★".repeat(starsN) + "☆".repeat(3 - starsN);
    const record = {
      mint: tok.mint, symbol: tok.symbol, at: Date.now(),
      smartCount, velocity: Math.round(velocity), entryMC: tok.peakMC,
    };
    db.signalHistory.unshift(record);
    if (db.signalHistory.length > 300) db.signalHistory.length = 300;
    markDirty();

    await tgSend(
      `🟢 <b>SİNYAL</b> — ${tok.symbol}\n${tok.name}\n\n` +
      `👥 Akıllı cüzdan: ${smartCount}\n` +
      `⚡ Hız (${CONFIG.VELOCITY_WINDOW_MIN}dk): %${Math.round(velocity)}\n` +
      `💰 MC: ${tok.peakMC.toFixed(2)} SOL\n` +
      `⏱ Yaş: ${Math.round(ageSec)}sn\n` +
      `🎯 Kalite: ${stars}\n` +
      `🔗 <code>${tok.mint}</code>\n\n` +
      `Takip için: /onayla ${tok.mint.slice(0, 8)}\n` +
      `https://pump.fun/${tok.mint}\nhttps://dexscreener.com/solana/${tok.mint}`
    );
  }
}

// ---------- ONAYLI SİNYAL TAKİBİ ----------
async function checkApprovedCheckpoints(tok) {
  const ap = db.approved[tok.mint];
  if (!ap) return;
  const ratio = tok.peakMC / ap.entryMC;
  for (const cp of CONFIG.CHECKPOINTS) {
    if (ratio >= cp && !ap.notified.includes(cp)) {
      ap.notified.push(cp);
      markDirty();
      await tgSend(`🚀 <b>${tok.symbol}</b> ${cp}x'e ulaştı! (şu an ${ratio.toFixed(2)}x)`);
    }
  }
}

async function finalizeApproved(mint, tok) {
  const ap = db.approved[mint];
  if (!ap) return;
  const ratio = (tok ? tok.peakMC : ap.entryMC) / ap.entryMC;
  await tgSend(`🏁 <b>${ap.symbol}</b> takip sona erdi. Final: ${ratio.toFixed(2)}x ${ratio >= 1 ? "✅" : "❌"}`);
  delete db.approved[mint];
  markDirty();
}

// ---------- YENİ TOKEN ----------
function onNewToken(t, ws) {
  if (!t.mint || state.tracked.has(t.mint)) return;
  if (!t.name || t.name.trim().length < 2) return;
  if ((t.solAmount || 0) < CONFIG.MIN_LAUNCH_BUY_SOL) return;
  if (state.tracked.size >= CONFIG.MAX_TRACKED_TOKENS) return; // kapasite dolu, bu tur atlanır

  const now = Date.now();
  const startMC = t.marketCapSol || 0.01;
  state.tracked.set(t.mint, {
    mint: t.mint, symbol: t.symbol || "?", name: t.name,
    launchMC: startMC, launchTime: now,
    peakMC: startMC, lastTradeTime: now,
    buyers: new Map(),        // wallet -> {mc, time} (erken alıcılar)
    smartBuyers: new Set(),
    mcHistory: [{ mc: startMC, t: now }],
    signaled: false,
  });
  try { ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [t.mint] })); } catch {}
}

function onTokenTrade(m) {
  const tok = state.tracked.get(m.mint);
  if (!tok || !m.marketCapSol) return;
  const now = Date.now();
  tok.lastTradeTime = now;
  if (m.marketCapSol > tok.peakMC) tok.peakMC = m.marketCapSol;
  tok.mcHistory.push({ mc: m.marketCapSol, t: now });
  if (tok.mcHistory.length > 80) tok.mcHistory.shift();

  if (m.txType === "buy" && m.traderPublicKey) {
    const ageSec = (now - tok.launchTime) / 1000;
    if (ageSec <= CONFIG.EARLY_WINDOW_SEC && !tok.buyers.has(m.traderPublicKey)) {
      tok.buyers.set(m.traderPublicKey, { mc: m.marketCapSol, time: now });
    }
    if (smartWalletSet.has(m.traderPublicKey)) tok.smartBuyers.add(m.traderPublicKey);
  }

  maybeSignal(tok);
  checkApprovedCheckpoints(tok);
}

// ---------- SONUÇLANDIRMA (KAZANAN/KAYBEDEN) ----------
function finalizeToken(mint, tok, ws) {
  const ratio = tok.peakMC / tok.launchMC;
  const isWin = ratio >= CONFIG.WIN_MULTIPLE;
  for (const wallet of tok.buyers.keys()) {
    const w = db.walletStats[wallet] || { wins: 0, total: 0, sumMultiple: 0, lastSeen: 0 };
    w.total++;
    if (isWin) w.wins++;
    w.sumMultiple += ratio;
    w.lastSeen = Date.now();
    db.walletStats[wallet] = w;
  }
  markDirty();
  if (db.approved[mint]) finalizeApproved(mint, tok);
  state.tracked.delete(mint);
  try { ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] })); } catch {}
}

function sweepTracked(ws) {
  const now = Date.now();
  for (const [mint, tok] of state.tracked) {
    const ageMs = now - tok.launchTime;
    const idleMs = now - tok.lastTradeTime;
    if (ageMs >= CONFIG.TRACK_WINDOW_HOURS * 3600000 || idleMs >= CONFIG.DEAD_AFTER_MIN * 60000) {
      finalizeToken(mint, tok, ws);
    }
  }
}

// ---------- AKILLI CÜZDAN LİSTESİNİ YENİDEN HESAPLA ----------
function recomputeSmartWallets() {
  const list = Object.entries(db.walletStats)
    .filter(([, w]) => w.total > 0 && w.wins >= CONFIG.MIN_WINS_FOR_SMART && w.wins / w.total >= CONFIG.MIN_WINRATE_FOR_SMART)
    .map(([wallet, w]) => ({
      wallet, wins: w.wins, total: w.total,
      winRate: w.wins / w.total, avgMultiple: w.sumMultiple / w.total, lastSeen: w.lastSeen,
    }))
    .sort((a, b) => b.avgMultiple - a.avgMultiple)
    .slice(0, CONFIG.MAX_SMART_WALLETS);

  smartWalletSet = new Set(list.map((x) => x.wallet));
  db.smartWallets = list;
  db.lastMinedAt = Date.now();
  markDirty();
  tgSend(`🧠 Akıllı cüzdan listesi güncellendi: ${list.length} cüzdan (toplam ölçülen: ${Object.keys(db.walletStats).length}).`);
}

// ---------- BAŞLAT ----------
function start() {
  log("BOT", "Akıllı cüzdan + hız sinyal botu başlıyor");
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => {
    log("WS", "PumpPortal bağlandı");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    tgSend(
      `🤖 Sinyal botu çalışıyor!\nAkıllı cüzdan: ${smartWalletSet.size}\nKomutlar: /durum /liste /sinyaller /onayla /durdur /baslat`
    );
    setInterval(() => sweepTracked(ws), CONFIG.SWEEP_INTERVAL_SEC * 1000);
  });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.txType === "create") onNewToken(m, ws);
      else if (m.txType === "buy" || m.txType === "sell") onTokenTrade(m);
    } catch (e) {}
  });
  ws.on("close", () => { log("WS", "Koptu, 5sn sonra tekrar"); setTimeout(start, 5000); });
  ws.on("error", (e) => log("WS", e.message));
}

setInterval(() => { if (dirty) { saveDb(db); dirty = false; } }, CONFIG.PERSIST_INTERVAL_SEC * 1000);
setInterval(recomputeSmartWallets, CONFIG.MINE_INTERVAL_HOURS * 3600 * 1000);
// Yeterli veri birikmesi için ilk cüzdan hesaplamasını hemen değil, biraz veri toplandıktan sonra yap
setTimeout(recomputeSmartWallets, 30 * 60 * 1000);

process.on("SIGTERM", () => { saveDb(db); process.exit(0); });
process.on("SIGINT", () => { saveDb(db); process.exit(0); });

tgPollCommands();
start();
