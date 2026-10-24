# Nasiya hisobi

Nasiyaga mashina sotuvchi uchun Telegram mini app va bot.

- **Sotuvchi:** mijoz qo'shadi, mijoz yuborgan to'lovni chek rasmi bilan ko'rib tasdiqlaydi yoki rad etadi, kechikkanlarni va hisobotni ko'radi.
- **Mijoz:** o'z qarzi va to'lov kunini ko'radi, to'lovni chek rasmi bilan kiritadi va sotuvchi tasdiqlashini kutadi.
- **Bot:** to'lovga 10 va 5 kun qolganda, to'lov kuni va kechikkanda mijozga va sotuvchiga xabar yuboradi. Yangi to'lov kelganda va tasdiqlanganda ham xabar boradi.

## Qanday ishlaydi

1. Foydalanuvchi botga `/start` yozadi va **"Raqamni yuborish"** tugmasini bosadi.
2. Raqam `SELLER_PHONES` ro'yxatida bo'lsa, u **sotuvchi** bo'ladi.
3. Aks holda sotuvchi mijozni qo'shishda kiritgan telefon raqami bilan solishtiriladi. Mos kelsa, mijoz o'z hisobiga bog'lanadi.
4. Mos kelmasa, hech narsa ochilmaydi.

Parol yo'q: kim ekani Telegram orqali tekshiriladi. Mijoz faqat o'z ma'lumotini ko'radi.

## Kerak bo'ladigan narsalar

- Server (Linux), **Node.js 22.13 yoki yangisi**. Boshqa dastur o'rnatish shart emas.
- Internetdagi **HTTPS** manzil (Telegram mini app uchun majburiy).
- BotFather bergan **token**.

## Sinab ko'rish (kompyuterda)

```
node test.js
```

Hammasi o'tsa, oxirida "ta tekshiruv o'tdi" yoziladi.

## Sozlash

1. `.env.example` faylidan `.env` nomli nusxa oling.
2. To'ldiring:
   - `BOT_TOKEN`: BotFather bergan token. **Hech kimga ko'rsatmang.**
   - `BOT_USERNAME`: botning nomi, `@` belgisisiz.
   - `SELLER_PHONES`: sotuvchi telefon raqami.
   - `APP_URL`: ilovaning HTTPS manzili, oxirida `/` bo'lmasin.
3. Ishga tushiring:

```
node server.js
```

## Serverda doimiy ishlatish (Linux)

`systemd` xizmati: `/etc/systemd/system/nasiya.service`

```
[Unit]
Description=Nasiya hisobi
After=network.target

[Service]
WorkingDirectory=/opt/nasiya
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
User=nasiya

[Install]
WantedBy=multi-user.target
```

Keyin: `systemctl enable --now nasiya`

HTTPS uchun eng oson yo'l: domenni serverga yo'naltirib, **Caddy** o'rnatish. `Caddyfile`:

```
sizning-domeningiz.uz {
    reverse_proxy localhost:3000
}
```

Caddy sertifikatni o'zi oladi va yangilaydi.

## Ma'lumotlarni saqlash (zaxira nusxa)

Hamma ma'lumot (mijozlar, to'lovlar, chek rasmlari) bitta faylda: `data/nasiya.db`.
Uni har kuni boshqa joyga nusxalab turing. Server yo'qolsa, shu fayl bilan hammasi tiklanadi.

Misol (har kuni 03:00 da nusxa, 14 kunlik): `crontab -e` ga qo'shing

```
0 3 * * * cp /opt/nasiya/data/nasiya.db /opt/nasiya-zaxira/nasiya-$(date +\%F).db && find /opt/nasiya-zaxira -mtime +14 -delete
```

## Xavfsizlik

- `.env` faylini hech kimga yubormang va internetga qo'ymang. Token tarqalib ketsa, BotFather'da `/revoke` qiling.
- Server faqat Telegram imzosi to'g'ri bo'lgan so'rovlarga javob beradi. Mijoz boshqa mijozning ma'lumotini va chek rasmini ko'ra olmaydi.
- Pasport ma'lumoti saqlanmaydi.

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `server.js` | server, bot, eslatmalar |
| `logic.js` | qarz, kechikish, to'lov kuni hisobi |
| `public/index.html` | mini app (ko'rinish) |
| `test.js` | avtomatik tekshiruv |
| `.env.example` | sozlamalar namunasi |
