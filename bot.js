/**
 * PUMP.FUN SNIPER BOT — Bulut + Telegram Kontrollü Sürüm
 * =======================================================
 * MİMARİ:
 *   GitHub (kod burada durur) -> Railway/Render (7/24 çalıştırır) -> Telegram (telefondan yönetirsin)
 *
 * TELEGRAM KOMUTLARI:
 *   /durum   -> bot durumu, günlük işlem sayısı, kâr/zarar
 *   /durdur  -> yeni işlem açmayı durdurur (açık pozisyonları takibe devam eder)
 *   /baslat  -> işlem açmayı tekrar aktif eder
 *   /mod     -> DRY_RUN (test) <-> LIVE (gerçek) arasında geçiş yapar
 *   /ayarlar -> aktif filtre ve limit ayarlarını gösterir
 *
 * GEREKLİ ORTAM DEĞİŞKENLERİ (Railway/Render panelinden girilir, koda yazılmaz):
 *   TELEGRAM_BOT_TOKEN   -> @BotFather'dan alınır
 *   TELEGRAM_CHAT_ID     -> @userinfobot'a yazınca sana ID'ni söyler
 *   PUMPPORTAL_API_KEY   -> pumpportal.fun (sadece LIVE mod için gerekli)
 */

const WebSocket = require("ws");
const http = require("http");

// ---- RENDER ÜCRETSİZ PLAN İÇİN MİNİ WEB SUNUCUSU ----
// Render'ın ücretsiz planı bir port dinleyen servis ister.
// UptimeRobot bu adrese 5 dk'da bir istek atarak botu uyanık tutar.
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Bot ayakta | mod: ${state?.dryRun ? "TEST" : "CANLI"} | acik pozisyon: ${state?.openPositions?.size ?? 0}`);
}).listen(process.env.PORT || 3000, () => console.log("Saglik sunucusu hazir"));

// ====================== AYARLAR ======================
const CONFIG = {
  DRY_RUN: true,             // Güvenlik için varsayılan: test modu. /mod komutuyla değişir.
  BUY_AMOUNT_SOL: 0.03,
  SLIPPAGE: 15,
  PRIORITY_FEE: 0.0008,

  // Filtreler
  MAX_DEV_HOLD_PCT: 15,
  MIN_INITIAL_BUY_SOL: 0.1,
  MAX_INITIAL_BUY_SOL: 10,
  REQUIRE_SOCIALS: false,

  // Çıkış stratejisi
  TAKE_PROFIT_X: 2.0,
  PARTIAL_TP_X: 1.5,         // 1.5x'te yarısını sat (kârı kademeli al)
  STOP_LOSS_PCT: 40,
  MAX_HOLD_SECONDS: 600,

  // Koruma limitleri
  MAX_TRADES_PER_DAY: 30,
  MAX_DAILY_LOSS_SOL: 0.15,
};
// =====================================================

const state = {
  active: true,
  dryRun: CONFIG.DRY_RUN,
  tradesToday: 0,
  wins: 0,
  losses: 0,
  dailyPnlSol: 0,
  openPositions: new Map(),
  seenMints: new Set(),
  startedAt: Date.now(),
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

// ---------- TELEGRAM ----------
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) { log("TG", `Mesaj gönderilemedi: ${e.message}`); }
}

let tgOffset = 0;
async function tgPollCommands() {
  if (!TG_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${tgOffset}&timeout=25`);
    const data = await res.json();
    for (const upd of data.result || []) {
      tgOffset = upd.update_id + 1;
      const text = upd.message?.text?.trim().toLowerCase();
      const from = String(upd.message?.chat?.id);
      if (!text || from !== String(TG_CHAT)) continue; // sadece senin komutların

      if (text === "/durum") {
        const winRate = state.tradesToday ? ((state.wins / (state.wins + state.losses || 1)) * 100).toFixed(0) : 0;
        await tgSend(
          `📊 <b>BOT DURUMU</b>\n` +
          `Mod: ${state.dryRun ? "🟡 TEST (DRY_RUN)" : "🔴 CANLI"}\n` +
          `İşlem açma: ${state.active ? "✅ aktif" : "⏸ durduruldu"}\n` +
          `Bugünkü işlem: ${state.tradesToday}/${CONFIG.MAX_TRADES_PER_DAY}\n` +
          `Kazanan/Kaybeden: ${state.wins}/${state.losses} (%${winRate})\n` +
          `Günlük PnL: ${state.dailyPnlSol.toFixed(4)} SOL\n` +
          `Açık pozisyon: ${state.openPositions.size}\n` +
          `Çalışma süresi: ${Math.floor((Date.now() - state.startedAt) / 60000)} dk`
        );
      } else if (text === "/durdur") {
        state.active = false;
        await tgSend("⏸ Yeni işlem açma DURDURULDU. Açık pozisyonlar takip ediliyor.");
      } else if (text === "/baslat") {
        state.active = true;
        await tgSend("▶️ İşlem açma AKTİF.");
      } else if (text === "/mod") {
        state.dryRun = !state.dryRun;
        await tgSend(state.dryRun
          ? "🟡 TEST moduna geçildi. İşlemler simüle edilecek."
          : "🔴 <b>CANLI moda geçildi! Gerçek para kullanılacak.</b> Emin değilsen /mod ile geri dön.");
      } else if (text === "/ayarlar") {
        await tgSend(
          `⚙️ <b>AYARLAR</b>\n` +
          `İşlem tutarı: ${CONFIG.BUY_AMOUNT_SOL} SOL\n` +
          `Kâr al: ${CONFIG.TAKE_PROFIT_X}x (kademeli: ${CONFIG.PARTIAL_TP_X}x'te yarısı)\n` +
          `Zarar kes: -%${CONFIG.STOP_LOSS_PCT}\n` +
          `Zaman stopu: ${CONFIG.MAX_HOLD_SECONDS / 60} dk\n` +
          `Maks. kurucu payı: %${CONFIG.MAX_DEV_HOLD_PCT}\n` +
          `Günlük limit: ${CONFIG.MAX_TRADES_PER_DAY} işlem / ${CONFIG.MAX_DAILY_LOSS_SOL} SOL zarar`
        );
      }
    }
  } catch (e) { /* sessizce yeniden dene */ }
  setTimeout(tgPollCommands, 1000);
}

// ---------- FİLTRELER ----------
function applyFilters(t) {
  const reasons = [];
  if (!t.name || t.name.trim().length < 2) reasons.push("isimsiz");
  if (CONFIG.REQUIRE_SOCIALS && !(t.twitter || t.telegram || t.website)) reasons.push("sosyal yok");
  const devBuy = t.solAmount || 0;
  if (devBuy < CONFIG.MIN_INITIAL_BUY_SOL) reasons.push(`kurucu alımı düşük (${devBuy})`);
  if (devBuy > CONFIG.MAX_INITIAL_BUY_SOL) reasons.push(`kurucu alımı yüksek (${devBuy})`);
  if (t.initialBuy) {
    const pct = (t.initialBuy / 1_000_000_000) * 100;
    if (pct > CONFIG.MAX_DEV_HOLD_PCT) reasons.push(`kurucu %${pct.toFixed(1)} tutuyor`);
  }
  return { passed: reasons.length === 0, reasons };
}

// ---------- İŞLEM ----------
async function executeTrade(action, mint, amount, inSol) {
  if (state.dryRun) {
    log("DRY", `${action} simüle -> ${mint}`);
    return { ok: true };
  }
  try {
    const res = await fetch(`https://pumpportal.fun/api/trade?api-key=${process.env.PUMPPORTAL_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action, mint, amount,
        denominatedInSol: inSol ? "true" : "false",
        slippage: CONFIG.SLIPPAGE, priorityFee: CONFIG.PRIORITY_FEE, pool: "pump",
      }),
    });
    const data = await res.json();
    if (data.errors?.length) { log("HATA", JSON.stringify(data.errors)); return { ok: false }; }
    return { ok: true, sig: data.signature };
  } catch (e) { log("HATA", e.message); return { ok: false }; }
}

// ---------- POZİSYON ----------
async function closePosition(mint, reason, ratio) {
  const pos = state.openPositions.get(mint);
  if (!pos) return;
  state.openPositions.delete(mint);
  await executeTrade("sell", mint, "100%", false);

  const pnl = (ratio - 1) * CONFIG.BUY_AMOUNT_SOL;
  state.dailyPnlSol += pnl;
  if (ratio >= 1) state.wins++; else state.losses++;

  await tgSend(`${ratio >= 1 ? "✅" : "❌"} <b>POZİSYON KAPANDI</b>\n${pos.symbol} | ${reason}\nSonuç: ${ratio.toFixed(2)}x | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`);

  if (state.dailyPnlSol <= -CONFIG.MAX_DAILY_LOSS_SOL) {
    state.active = false;
    await tgSend("🛑 <b>GÜNLÜK ZARAR LİMİTİ AŞILDI.</b> Bot durduruldu. Yarın /baslat ile açabilirsin.");
  }
}

function onTokenTrade(msg) {
  const pos = state.openPositions.get(msg.mint);
  if (!pos || !msg.marketCapSol) return;
  const ratio = msg.marketCapSol / pos.entryMC;

  // Kademeli kâr alma: 1.5x'te yarısını sat
  if (!pos.partialTaken && ratio >= CONFIG.PARTIAL_TP_X) {
    pos.partialTaken = true;
    executeTrade("sell", msg.mint, "50%", false);
    tgSend(`💰 ${pos.symbol}: ${CONFIG.PARTIAL_TP_X}x'e ulaştı, yarısı satıldı. Kalan kısım ${CONFIG.TAKE_PROFIT_X}x hedefinde.`);
  }
  if (ratio >= CONFIG.TAKE_PROFIT_X) closePosition(msg.mint, "kâr al hedefi", ratio);
  else if (ratio <= 1 - CONFIG.STOP_LOSS_PCT / 100) closePosition(msg.mint, "zarar kes", ratio);
}

// ---------- YENİ TOKEN ----------
async function onNewToken(t, ws) {
  if (state.seenMints.has(t.mint)) return;
  state.seenMints.add(t.mint);
  if (!state.active || state.tradesToday >= CONFIG.MAX_TRADES_PER_DAY) return;

  const { passed, reasons } = applyFilters(t);
  if (!passed) { log("ELE", `${t.symbol}: ${reasons.join(", ")}`); return; }

  const result = await executeTrade("buy", t.mint, CONFIG.BUY_AMOUNT_SOL, true);
  if (result.ok) {
    state.tradesToday++;
    state.openPositions.set(t.mint, { entryMC: t.marketCapSol || 30, symbol: t.symbol, opened: Date.now(), partialTaken: false });
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [t.mint] }));
    await tgSend(`🎯 <b>YENİ POZİSYON</b> ${state.dryRun ? "(TEST)" : "(CANLI)"}\n${t.symbol} — ${t.name}\nKurucu alımı: ${t.solAmount} SOL\nMC: ${(t.marketCapSol || 0).toFixed(1)} SOL\nmint: <code>${t.mint}</code>`);

    setTimeout(() => {
      const pos = state.openPositions.get(t.mint);
      if (pos) closePosition(t.mint, "zaman stopu", 1); // bilinmiyorsa nötr say
    }, CONFIG.MAX_HOLD_SECONDS * 1000);
  }
}

// ---------- GÜNLÜK SIFIRLAMA ----------
setInterval(() => {
  const h = new Date().getUTCHours();
  if (h === 0 && state.tradesToday > 0) {
    state.tradesToday = 0; state.dailyPnlSol = 0; state.wins = 0; state.losses = 0;
    tgSend("🔄 Yeni gün: sayaçlar sıfırlandı.");
  }
}, 60 * 60 * 1000);

// ---------- BAŞLAT ----------
function start() {
  log("BOT", `Başlıyor | mod: ${state.dryRun ? "TEST" : "CANLI"}`);
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => {
    log("WS", "PumpPortal bağlandı");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    tgSend(`🤖 Bot çalışıyor! Mod: ${state.dryRun ? "🟡 TEST" : "🔴 CANLI"}\nKomutlar: /durum /durdur /baslat /mod /ayarlar`);
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

tgPollCommands();
start();
