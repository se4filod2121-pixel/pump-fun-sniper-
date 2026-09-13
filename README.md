# 📱 Pump.fun Sniper Bot — Telefondan Kurulum Rehberi

Bu bot GitHub'da durur, Railway bulutunda 7/24 çalışır, sen Telegram'dan yönetirsin.
**Tüm adımlar telefonun tarayıcısından yapılabilir. Bilgisayar gerekmez.**

---

## ADIM 1 — Telegram botunu oluştur (2 dakika)

1. Telegram'da **@BotFather**'ı aç, `/newbot` yaz
2. Bota bir isim ve kullanıcı adı ver (sonu `bot` ile bitmeli)
3. Sana verdiği **TOKEN**'ı kopyala (örn: `123456:ABC-DEF...`) → bu `TELEGRAM_BOT_TOKEN`
4. Telegram'da **@userinfobot**'a herhangi bir mesaj at → sana ID'ni söyler → bu `TELEGRAM_CHAT_ID`
5. Kendi oluşturduğun bota gidip **/start**'a bas (yoksa sana mesaj atamaz)

## ADIM 2 — Kodu GitHub'a yükle (5 dakika)

1. Tarayıcıdan **github.com**'a gir, hesap aç (yoksa)
2. Sağ üstten **+ → New repository** → isim: `pumpfun-sniper` → **Private** seç → Create
3. Repo sayfasında **Add file → Upload files** ile şu 3 dosyayı yükle:
   - `bot.js`
   - `package.json`
   - `README.md`
4. **Commit changes**'a bas

## ADIM 3 — Railway'de çalıştır (5 dakika)

1. Tarayıcıdan **railway.app**'e gir → **Login with GitHub** ile giriş yap
2. **New Project → Deploy from GitHub repo** → `pumpfun-sniper` reposunu seç
3. Proje açılınca **Variables** sekmesine gir, şunları ekle:
   | Değişken | Değer |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | BotFather'dan aldığın token |
   | `TELEGRAM_CHAT_ID` | userinfobot'tan aldığın ID |
   | `PUMPPORTAL_API_KEY` | (şimdilik boş bırakabilirsin — sadece CANLI mod için gerekli) |
4. Railway otomatik kurup başlatır. 1-2 dakika içinde Telegram'dan
   "🤖 Bot çalışıyor!" mesajı gelmeli.

> Railway ücretsiz deneme kredisi verir; sonrasında ayda ~5$ civarı ücretlidir.
> Ücretsiz alternatif: **render.com** (Background Worker olarak aynı şekilde kurulur,
> ama ücretsiz planda arada uyku moduna girebilir).

## ADIM 4 — Telefondan yönet

Telegram'da kendi botuna şu komutları yazabilirsin:

| Komut | Ne yapar |
|---|---|
| `/durum` | İşlem sayısı, kazanma oranı, günlük kâr/zarar |
| `/durdur` | Yeni işlem açmayı durdurur |
| `/baslat` | Tekrar başlatır |
| `/mod` | TEST ↔ CANLI geçişi |
| `/ayarlar` | Aktif filtre ve limitleri gösterir |

Bot ayrıca her pozisyon açılış/kapanışında sana bildirim atar.

---

## ⚠️ CANLI MODA GEÇMEDEN ÖNCE — MUTLAKA OKU

1. Bot **TEST modunda başlar** ve işlemleri sadece simüle eder.
   **En az 2-3 gün** test modunda çalıştır, `/durum` ile kazanma oranına bak.
   Oran %50'nin altındaysa (büyük ihtimalle öyle olacak) canlıya GEÇME.
2. Canlı mod için **pumpportal.fun**'dan API anahtarı al (Lightning Wallet
   oluşturur, her işlemden %0,5-1 komisyon keser) ve Railway Variables'a ekle.
3. O cüzdana **sadece tamamen kaybetmeyi göze aldığın kadar SOL** gönder.
4. Gerçekçi ol: Profesyonel sniper'lar özel RPC sunucuları ve milisaniyelik
   altyapıyla çalışır ve senden önce girer. Bu bot onlarla yarışamaz —
   filtreli, disiplinli, limitli bir başlangıç aracıdır. "5 doları 1000 yapma"
   beklentisi piyangodur; bu botun limitleri seni büyük kayıptan korumak için var.

---

## 🧠 YENİ: Akıllı Cüzdan + Hız Sinyal Botu (`smart-signal-bot.js`)

`bot.js`'ten farklı bir yaklaşım: otomatik alım yapmaz, sadece **"kaç akıllı
cüzdan bu token'ı aldı + ne hızla yükseliyor"** bilgisini Telegram'a sinyal
olarak düşer, alıp almama kararını sen verirsin.

**"Akıllı cüzdan" nereden geliyor?** Dışarıdan ücretli bir API kullanmıyor —
bot PumpPortal'ın zaten ücretsiz olan canlı akışını izleyerek kendi kendine
öğreniyor: her yeni token'ın ilk ~90 saniyesindeki alıcılarını kaydeder,
token'ın kaderi belli olunca (3x+ yaptıysa "kazanan") o erken alıcılara puan
verir. 12 saatte bir en yüksek puanlı cüzdanlardan bir liste çıkarır.

⚠️ **Soğuk başlangıç:** Bot ilk kez çalıştığında bu liste boştur. İlk 24-48
saat sadece veri toplar, sinyaller seyrek/hiç gelmeyebilir. Zaman geçtikçe
(özellikle birkaç 12 saatlik döngüden sonra) liste büyür ve sinyaller
anlamlı hale gelir. Bu bir hata değil, tasarımın doğal sonucu.

### Railway/Render kurulumu

`bot.js` yerine bu dosyayı çalıştırmak için Railway/Render'da **Start
Command**'ı şu şekilde değiştir:

```
node smart-signal-bot.js
```

Gerekli ortam değişkenleri:

| Değişken | Değer |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather'dan aldığın token |
| `TELEGRAM_CHAT_ID` | userinfobot'tan aldığın ID |
| `DATA_DIR` (opsiyonel) | Kalıcı verinin yazılacağı klasör — Railway'de bir **Volume** bağlarsan onun mount path'i (örn. `/data`). Verilmezse veri kod dizinine yazılır ve **her deploy'da sıfırlanır**. |

### Telegram komutları

| Komut | Ne yapar |
|---|---|
| `/durum` | İzlenen token, akıllı cüzdan sayısı, bugünkü sinyal sayısı |
| `/liste` | En iyi akıllı cüzdanlar (kısa özet) |
| `/sinyaller` | Son sinyaller (sonuçlanmışsa gerçek çarpanla birlikte) |
| `/kalite` | Tüm sinyallerin gerçek sonuç istatistiği: ortalama çarpan, 2x/5x oranı, zararda kapanan yüzdesi |
| `/onayla <mint önek>` | Bir sinyali takibe al — 2x/5x/10x/20x'e ulaşınca haber verir |
| `/durdur` / `/baslat` | Yeni sinyal üretimini durdur/aç (öğrenme her zaman devam eder) |
| `/ayarlar` | Aktif eşik ve limitleri gösterir |

### Rug/uyarı tespiti

Ekstra veri kaynağı gerekmez — zaten dinlenen trade akışından çıkarılır:
- **Kurucu erken sattı** — token'ı oluşturan cüzdan ilk birkaç dakika içinde
  satarsa sinyale ⚠️ eklenir, kalite yıldızı otomatik düşer.
- **Erken satış yoğun** — kısa sürede çok sayıda satış olması (dump belirtisi).

### Cüzdan skorlaması

Basit kazanma oranından daha gelişmiş: büyük pozisyonla kazanmak küçük
pozisyondan daha değerli sayılır (ağırlıklı ortalama), ve eski performansın
etkisi zamanla azalır (14 günde yarıya iner) — böylece liste sürekli
güncel kalır, eskiden bir kez tutturmuş ama artık aktif olmayan cüzdanlar
öne çıkmaz.

### Veri kalıcılığı

Bot öğrendiği her şeyi (`smart-signal-data.json`, `DATA_DIR` altında) diske
yazar. **Railway'de kalıcı olması için servise bir Volume bağlaman ve
`DATA_DIR`'i o volume'ün mount path'ine ayarlaman gerekir** — aksi halde
her deploy'da (kod güncellemesi, restart) öğrendiği tüm cüzdan verisi
sıfırlanır.

### Bilinmesi gerekenler / sınırlar

- Bu bot **sinyal üretir, otomatik alım-satım yapmaz**. Gerçek işlem
  yapmak istersen ayrı bir execution katmanı (örn. PumpPortal Lightning
  API veya Jupiter) eklemek gerekir — bu, gerçek para riskini artıran
  ayrı bir karar olduğu için bilinçli şekilde bu botun kapsamı dışında
  tutuldu.
- Hız/rekabet: profesyonel botlar özel RPC (Jito bundle, 0slot, Nozomi
  gibi) kullanarak milisaniyeler içinde işlem gönderir. Bu bot public
  PumpPortal WebSocket'i kullanır — sinyal üretiminde bu fark önemli
  değil (saniyeler içinde tespit ediyoruz), ama otomatik alıma geçersen
  bu hız farkı kâr/zarar üzerinde belirleyici olur.
