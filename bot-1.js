/**
 * PUMP.FUN İZLEME BOTU — "Hiç Satmasaydık?" Deney Sürümü
 * =======================================================
 * BU SÜRÜM NE YAPAR:
 *  - Yeni coinleri yakalar, sanal pozisyon açar ama ASLA SATMAZ
 *  - Aynı anda en fazla MAX_OPEN_POSITIONS coin izler (bellek koruması)
 *  - Her pozisyon için ayrı bildirim YOK (spam önleme) — bunun yerine
 *    6 saatte bir TOPLU RAPOR: ortalama çarpan, kaç tanesi 2x+, kaçı öldü
 *  - 7 gün sonunda her pozisyon için final durumu raporlar
 *
 * ÖNEMLİ UYARI:
 *  - Veriler bellekte tutulur. Render servisi yeniden başlarsa (deploy,
 *    çökme, bakım) izleme verisi SIFIRLANIR ve bot sana haber verir.
 *
 * TELEGRAM KOMUTLARI:
 *  /durum   -> anlık izleme istatistikleri
 *  /rapor   -> toplu raporu hemen iste
 *  /durdur  -> yeni coin eklemeyi durdur (izleme devam eder)
 *  /baslat  -> yeni coin eklemeyi aç
 *  /ayarlar -> aktif ayarlar
 */

const WebSocket = require("ws");
const http = require("http");

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Izleme botu ayakta | izlenen: ${state?.positions?.size ?? 0}`);
}).listen(process.env.PORT || 3000, () => console.log("Saglik sunucusu hazir"));

// ====================== AYARLAR ======================
const CONFIG = {
  MAX_OPEN_POSITIONS: 150,    // Aynı anda izlenecek maksimum coin (bellek koruması)
  TRACK_DAYS: 7,              // Her coin kaç gün izlensin
  REPORT_EVERY_HOURS: 6,      // Kaç saatte bir toplu rapor
  DEAD_AFTER_HOURS: 3,        // Bu kadar saat işlem görmeyen coin "ölü" sayılır

  // Filtreler (izleme için hafif tutuldu)
  MIN_INITIAL_BUY_SOL: 0.1,
  MAX_INITIAL_BUY_SOL: 10,
  MAX_DEV_HOLD_PCT: 15,
};
// =====================================================

const state = {
  active: true,
  positions: new Map(), // mint -> {symbol, name, entryMC, lastMC, lastTradeAt, openedAt}
  finished: [],         // 7 günü dolan pozisyonların final sonuçları
  seenMints: new Set(),
  totalAdded: 0,
  startedAt: Date.now(),
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) { log("TG", e.message); }
}

// ---------- İSTATİSTİK HESAPLAMA ----------
function computeStats() {
  const now = Date.now();
  let ratios = [], winners2x = 0, winners5x = 0, losers50 = 0, dead = 0;
  for (const p of state.positions.values()) {
    const ratio = p.lastMC / p.entryMC;
    ratios.push(ratio);
    if (ratio >= 5) winners5x++;
    else if (ratio >= 2) winners2x++;
    if (ratio <= 0.5) losers50++;
    if (now - p.lastTradeAt > CONFIG.DEAD_AFTER_HOURS * 3600 * 1000) dead++;
  }
  const n = ratios.length;
  const avg = n ? ratios.reduce((a, b) => a + b, 0) / n : 0;
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = n ? sorted[Math.floor(n / 2)] : 0;
  return { n, avg, median, winners2x, winners5x, losers50, dead };
}

function buildReport(title) {
  const s = computeStats();
  const days = ((Date.now() - state.startedAt) / 86400000).toFixed(1);
  return (
    `📊 <b>${title}</b> (gün ${days})\n` +
    `İzlenen coin: ${s.n} (toplam eklenen: ${state.totalAdded})\n` +
    `Ortalama çarpan: <b>${s.avg.toFixed(3)}x</b>\n` +
    `Medyan çarpan: ${s.median.toFixed(3)}x\n` +
    `🚀 5x üzeri: ${s.winners5x} | 2-5x arası: ${s.winners2x}\n` +
    `📉 Yarıdan fazla düşen: ${s.losers50}\n` +
    `💀 Ölü (${CONFIG.DEAD_AFTER_HOURS}+ saat işlemsiz): ${s.dead}\n` +
    `\n💡 Her coine eşit para dağıtsaydın portföyün şu an: <b>${s.avg.toFixed(3)}x</b>\n` +
    `(1.000x = başabaş; altı zarar, üstü kâr — komisyon/kayma hariç)`
  );
}

// ---------- TELEGRAM KOMUTLARI ----------
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
      if (!text || from !== String(TG_CHAT)) continue;

      if (text === "/durum") {
        const s = computeStats();
        await tgSend(
          `📊 <b>İZLEME DURUMU</b>\n` +
          `Yeni coin ekleme: ${state.active ? "✅ aktif" : "⏸ durdu"}\n` +
          `İzlenen: ${s.n}/${CONFIG.MAX_OPEN_POSITIONS}\n` +
          `Toplam eklenen: ${state.totalAdded}\n` +
          `Ortalama çarpan: ${s.avg.toFixed(3)}x\n` +
          `Çalışma: ${Math.floor((Date.now() - state.startedAt) / 3600000)} saat\n` +
          `Detaylı rapor için: /rapor`
        );
      } else if (text === "/rapor") {
        await tgSend(buildReport("ANLIK RAPOR"));
      } else if (text === "/durdur") {
        state.active = false;
        await tgSend("⏸ Yeni coin ekleme durduruldu. Mevcutlar izlenmeye devam ediyor.");
      } else if (text === "/baslat") {
        state.active = true;
        await tgSend("▶️ Yeni coin ekleme aktif.");
      } else if (text === "/ayarlar") {
        await tgSend(
          `⚙️ <b>AYARLAR</b>\n` +
          `Maks. izlenen: ${CONFIG.MAX_OPEN_POSITIONS}\n` +
          `İzleme süresi: ${CONFIG.TRACK_DAYS} gün\n` +
          `Rapor sıklığı: ${CONFIG.REPORT_EVERY_HOURS} saat\n` +
          `Mod: İZLEME (alım-satım YOK, sadece takip)`
        );
      }
    }
  } catch (e) {}
  setTimeout(tgPollCommands, 1000);
}

// ---------- FİLTRE ----------
function applyFilters(t) {
  if (!t.name || t.name.trim().length < 2) return false;
  const devBuy = t.solAmount || 0;
  if (devBuy < CONFIG.MIN_INITIAL_BUY_SOL || devBuy > CONFIG.MAX_INITIAL_BUY_SOL) return false;
  if (t.initialBuy && (t.initialBuy / 1_000_000_000) * 100 > CONFIG.MAX_DEV_HOLD_PCT) return false;
  return true;
}

// ---------- FİYAT GÜNCELLEME ----------
function onTokenTrade(msg) {
  const pos = state.positions.get(msg.mint);
  if (!pos || !msg.marketCapSol) return;
  pos.lastMC = msg.marketCapSol;
  pos.lastTradeAt = Date.now();
}

// ---------- YENİ TOKEN ----------
function onNewToken(t, ws) {
  if (state.seenMints.has(t.mint)) return;
  state.seenMints.add(t.mint);
  if (state.seenMints.size > 50000) state.seenMints.clear(); // bellek koruması

  if (!state.active) return;
  if (state.positions.size >= CONFIG.MAX_OPEN_POSITIONS) return; // kapasite dolu
  if (!applyFilters(t)) return;

  const entryMC = t.marketCapSol || 30;
  state.positions.set(t.mint, {
    symbol: t.symbol, name: t.name,
    entryMC, lastMC: entryMC,
    lastTradeAt: Date.now(), openedAt: Date.now(),
  });
  state.totalAdded++;
  ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [t.mint] }));
  log("EKLE", `${t.symbol} izlemeye alındı (${state.positions.size}/${CONFIG.MAX_OPEN_POSITIONS})`);

  if (state.positions.size === CONFIG.MAX_OPEN_POSITIONS) {
    tgSend(`📦 İzleme kapasitesi doldu (${CONFIG.MAX_OPEN_POSITIONS} coin). Yeni coin, mevcutlardan biri 7 günü doldurunca eklenecek. İlk toplu rapor ${CONFIG.REPORT_EVERY_HOURS} saat içinde gelecek — istersen /rapor ile hemen iste.`);
  }
}

// ---------- 7 GÜN DOLAN POZİSYONLARI SONLANDIR ----------
setInterval(() => {
  const now = Date.now();
  for (const [mint, p] of state.positions) {
    if (now - p.openedAt >= CONFIG.TRACK_DAYS * 86400000) {
      const ratio = p.lastMC / p.entryMC;
      state.finished.push({ symbol: p.symbol, ratio });
      state.positions.delete(mint);
      tgSend(`🏁 <b>7 GÜN DOLDU:</b> ${p.symbol}\nFinal: ${ratio.toFixed(3)}x ${ratio >= 1 ? "✅" : "❌"}`);
    }
  }
}, 10 * 60 * 1000);

// ---------- PERİYODİK RAPOR ----------
setInterval(() => {
  if (state.positions.size > 0) tgSend(buildReport("PERİYODİK RAPOR"));
}, CONFIG.REPORT_EVERY_HOURS * 3600 * 1000);

// ---------- BAŞLAT ----------
function start() {
  log("BOT", "İzleme botu başlıyor");
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => {
    log("WS", "PumpPortal bağlandı");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    // Yeniden bağlanmada eski abonelikleri tazele
    const mints = [...state.positions.keys()];
    if (mints.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
    tgSend(
      state.totalAdded === 0
        ? `🔭 <b>İzleme botu çalışıyor!</b>\nMod: SADECE TAKİP (alım-satım yok)\n${CONFIG.MAX_OPEN_POSITIONS} coine kadar izler, ${CONFIG.REPORT_EVERY_HOURS} saatte bir rapor atar, her coini ${CONFIG.TRACK_DAYS} gün takip eder.\nKomutlar: /durum /rapor /durdur /baslat /ayarlar`
        : `♻️ Bot yeniden başladı. DİKKAT: bellekteki izleme verisi sıfırlanmış olabilir (izlenen: ${state.positions.size}).`
    );
  });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.txType === "create") onNewToken(m, ws);
      else if (m.txType === "buy" || m.txType === "sell") onTokenTrade(m);
    } catch (e) {}
  });
  ws.on("close", () => { log("WS", "Koptu, 5sn"); setTimeout(start, 5000); });
  ws.on("error", (e) => log("WS", e.message));
}

tgPollCommands();
start();
