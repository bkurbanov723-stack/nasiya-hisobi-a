"use strict";
// Nasiya hisobi: server, Telegram bot va eslatmalar bitta faylda.
// Tashqi kutubxona kerak emas. Node 22.13 yoki yangisi talab qilinadi.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const L = require("./logic");

// ---------- .env ni o'qish ----------
(function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
})();

const CFG = {
  token: process.env.BOT_TOKEN || "",
  sellerPhones: (process.env.SELLER_PHONES || "").split(",").map((s) => phone9(s)).filter(Boolean),
  appUrl: (process.env.APP_URL || "").replace(/\/+$/, ""),
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(__dirname, "data", "nasiya.db"),
  reminderHour: Number(process.env.REMINDER_HOUR || 9),
  dev: process.env.DEV === "1",
};

function phone9(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
}

// ---------- baza ----------
fs.mkdirSync(path.dirname(CFG.dbPath), { recursive: true });
const db = new DatabaseSync(CFG.dbPath);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  tg_id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT, phone9 TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, phone9 TEXT NOT NULL,
  plate TEXT, car TEXT, day INTEGER NOT NULL, start TEXT NOT NULL, init REAL NOT NULL,
  total REAL NOT NULL, months INTEGER NOT NULL, photo TEXT, tg_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, date TEXT NOT NULL,
  amount REAL NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, photo TEXT,
  created_at TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS reminders(
  customer_id INTEGER, due TEXT, kind TEXT, sent_at TEXT, PRIMARY KEY(customer_id, due, kind));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_pay_cust ON payments(customer_id);
`);
const q = {
  userGet: db.prepare("SELECT * FROM users WHERE tg_id=?"),
  userUpsert: db.prepare("INSERT INTO users(tg_id,role,name,phone9,created_at) VALUES(?,?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET role=excluded.role,name=excluded.name,phone9=excluded.phone9"),
  sellers: db.prepare("SELECT tg_id,name FROM users WHERE role='seller'"),
  custAll: db.prepare("SELECT * FROM customers ORDER BY id"),
  custMine: db.prepare("SELECT * FROM customers WHERE tg_id=? ORDER BY id"),
  custGet: db.prepare("SELECT * FROM customers WHERE id=?"),
  custLink: db.prepare("UPDATE customers SET tg_id=? WHERE phone9=? AND (tg_id IS NULL OR tg_id=?)"),
  custFindPhone: db.prepare("SELECT id FROM customers WHERE phone9=? AND (tg_id IS NULL OR tg_id=?)"),
  custInsert: db.prepare("INSERT INTO customers(name,phone,phone9,plate,car,day,start,init,total,months,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"),
  payList: db.prepare("SELECT id,customer_id,date,amount,status,kind,(photo IS NOT NULL) AS has_photo FROM payments WHERE customer_id=? ORDER BY date,id"),
  payGet: db.prepare("SELECT * FROM payments WHERE id=?"),
  payInsert: db.prepare("INSERT INTO payments(customer_id,date,amount,status,kind,photo,created_at) VALUES(?,?,?,?,?,?,?)"),
  payDecide: db.prepare("UPDATE payments SET status=?,decided_at=? WHERE id=? AND status='wait'"),
  payPending: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id=? AND status='wait'"),
  remInsert: db.prepare("INSERT OR IGNORE INTO reminders(customer_id,due,kind,sent_at) VALUES(?,?,?,?)"),
  metaGet: db.prepare("SELECT v FROM meta WHERE k=?"),
  metaSet: db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"),
};

// ---------- Telegram API ----------
async function tg(method, body) {
  if (!CFG.token) { console.log("[bot o'chiq]", method, JSON.stringify(body).slice(0, 200)); return { ok: false }; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) {
    console.error("Telegram xatosi:", method, e.message);
    return { ok: false };
  }
}

function openButton(text) {
  if (!CFG.appUrl) return undefined;
  return { inline_keyboard: [[{ text: text || "Ilovani ochish", web_app: { url: CFG.appUrl } }]] };
}
async function notify(tgId, text, withButton) {
  if (!tgId) return;
  const body = { chat_id: tgId, text };
  if (withButton) body.reply_markup = openButton();
  await tg("sendMessage", body);
}
async function notifySellers(text) {
  for (const s of q.sellers.all()) await notify(s.tg_id, text, true);
}

// ---------- Telegram initData tekshiruvi ----------
function verifyInitData(initData) {
  if (!initData || !CFG.token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(CFG.token).digest();
  const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(p.get("auth_date") || 0);
  if (!(age >= 0 && age < 86400 * 2)) return null;
  try { const u = JSON.parse(p.get("user") || "null"); return u && u.id ? u : null; } catch { return null; }
}

function authUser(req, url) {
  const init = req.headers["x-init-data"] || url.searchParams.get("a") || "";
  const u = verifyInitData(String(init));
  if (u) return { tgId: u.id, tgName: [u.first_name, u.last_name].filter(Boolean).join(" ") };
  if (CFG.dev) {
    const d = req.headers["x-dev-user"] || url.searchParams.get("dev");
    if (d && /^\d+$/.test(String(d))) return { tgId: Number(d), tgName: "dev" };
  }
  return null;
}

function roleOf(auth) {
  const u = q.userGet.get(auth.tgId);
  return u ? { role: u.role, name: u.name || auth.tgName } : { role: "none", name: auth.tgName };
}

// ---------- yordamchi funksiyalar ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("katta")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
function okPhoto(s) { return typeof s === "string" && s.length < 3_000_000 && PHOTO_RE.test(s); }
function str(s, max) { return String(s == null ? "" : s).trim().slice(0, max); }
function num(n, min, max) { const x = Number(n); return Number.isFinite(x) && x >= min && x <= max ? x : null; }
function validMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || "")); }

function payOut(p) { return { id: p.id, date: p.date, amount: p.amount, status: p.status, kind: p.kind, hasPhoto: !!p.has_photo }; }
function custOut(c) {
  const pays = q.payList.all(c.id).map(payOut);
  return {
    id: c.id, name: c.name, phone: c.phone || "", plate: c.plate || "", car: c.car || "", day: c.day, start: c.start,
    init: c.init, total: c.total, months: c.months, hasPhoto: !!c.photo, linked: !!c.tg_id, pays,
  };
}
function todayISO() { return L.isoOfDayNum(L.todayNum()); }

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === "/api/health") return send(res, 200, { ok: true });

  const auth = authUser(req, url);
  if (!auth) return send(res, 401, { error: "Telegram orqali kiring" });
  const me = roleOf(auth);

  if (p === "/api/me" && m === "GET") return send(res, 200, { role: me.role, name: me.name, bot: process.env.BOT_USERNAME || "" });
  if (me.role === "none") return send(res, 403, { error: "Avval botda telefon raqamingizni yuboring" });
  const seller = me.role === "seller";

  // rasmlar (img tegi uchun, ?a= bilan)
  let mm = /^\/api\/photo\/(pay|car)\/(\d+)$/.exec(p);
  if (mm && m === "GET") {
    let data = null;
    if (mm[1] === "pay") {
      const pay = q.payGet.get(Number(mm[2]));
      const c = pay && q.custGet.get(pay.customer_id);
      if (pay && c && (seller || c.tg_id === auth.tgId)) data = pay.photo;
    } else {
      const c = q.custGet.get(Number(mm[2]));
      if (c && (seller || c.tg_id === auth.tgId)) data = c.photo;
    }
    if (!data) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": mm[1] === "pay" ? "private, max-age=86400" : "private, max-age=300" });
    return res.end(Buffer.from(data.split(",")[1], "base64"));
  }

  if (p === "/api/customers" && m === "GET") {
    const rows = seller ? q.custAll.all() : q.custMine.all(auth.tgId);
    return send(res, 200, { customers: rows.map(custOut) });
  }

  if (p === "/api/customers" && m === "POST") {
    if (!seller) return send(res, 403, { error: "Faqat sotuvchi" });
    const b = await readBody(req, 6e6);
    const name = str(b.name, 80), ph = str(b.phone, 30), plate = str(b.plate, 12).toUpperCase().replace(/\s/g, ""), car = str(b.car, 60);
    const day = num(b.day, 1, 31), init = num(b.init, 0, 1e7), total = num(b.total, 1, 1e7), months = num(b.months, 1, 120);
    const before = b.paidBefore === undefined || b.paidBefore === "" ? 0 : num(b.paidBefore, 0, 1e7);
    if (!name || !phone9(ph) || !validMonth(b.start) || day === null || init === null || total === null || months === null || before === null || !Number.isInteger(day) || !Number.isInteger(months))
      return send(res, 400, { error: "Ma'lumotlar to'liq emas yoki noto'g'ri" });
    const now = new Date().toISOString();
    const r = q.custInsert.run(name, ph, phone9(ph), plate, car, day, b.start, init, total, months, now);
    const id = Number(r.lastInsertRowid);
    if (before > 0) q.payInsert.run(id, todayISO(), before, "ok", "opening", null, now);
    // mijoz allaqachon botga kirgan bo'lsa, bog'lash uchun /start ni qayta bosishi kerak
    return send(res, 200, { customer: custOut(q.custGet.get(id)) });
  }

  mm = /^\/api\/customers\/(\d+)$/.exec(p);
  if (mm && m === "PATCH") {
    if (!seller) return send(res, 403, { error: "Faqat sotuvchi" });
    const c = q.custGet.get(Number(mm[1]));
    if (!c) return send(res, 404, { error: "Topilmadi" });
    const b = await readBody(req, 6e6);
    const f = { ...c };
    if (b.name !== undefined) f.name = str(b.name, 80) || c.name;
    if (b.plate !== undefined) f.plate = str(b.plate, 12).toUpperCase().replace(/\s/g, "");
    if (b.car !== undefined) f.car = str(b.car, 60);
    if (b.day !== undefined) { const d = num(b.day, 1, 31); if (d === null || !Number.isInteger(d)) return send(res, 400, { error: "To'lov kuni 1-31" }); f.day = d; }
    if (b.start !== undefined) { if (!validMonth(b.start)) return send(res, 400, { error: "Oy noto'g'ri" }); f.start = b.start; }
    if (b.init !== undefined) { const v = num(b.init, 0, 1e7); if (v === null) return send(res, 400, { error: "Summa noto'g'ri" }); f.init = v; }
    if (b.total !== undefined) { const v = num(b.total, 1, 1e7); if (v === null) return send(res, 400, { error: "Summa noto'g'ri" }); f.total = v; }
    if (b.months !== undefined) { const v = num(b.months, 1, 120); if (v === null || !Number.isInteger(v)) return send(res, 400, { error: "Muddat noto'g'ri" }); f.months = v; }
    if (b.phone !== undefined) {
      if (!phone9(b.phone)) return send(res, 400, { error: "Telefon raqami noto'g'ri" });
      f.phone = str(b.phone, 30);
      if (phone9(b.phone) !== c.phone9) { f.phone9 = phone9(b.phone); f.tg_id = null; } // raqam o'zgarsa, bog'lanish bekor
    }
    if (b.photo !== undefined) { if (b.photo !== null && !okPhoto(b.photo)) return send(res, 400, { error: "Rasm noto'g'ri" }); f.photo = b.photo; }
    db.prepare("UPDATE customers SET name=?,phone=?,phone9=?,plate=?,car=?,day=?,start=?,init=?,total=?,months=?,photo=?,tg_id=? WHERE id=?")
      .run(f.name, f.phone, f.phone9, f.plate, f.car, f.day, f.start, f.init, f.total, f.months, f.photo, f.tg_id, c.id);
    return send(res, 200, { customer: custOut(q.custGet.get(c.id)) });
  }

  if (p === "/api/payments" && m === "POST") {
    if (seller) return send(res, 403, { error: "To'lovni mijoz kiritadi, sotuvchi tasdiqlaydi" });
    const b = await readBody(req, 6e6);
    const mine = q.custMine.all(auth.tgId);
    const c = b.customerId ? mine.find((x) => x.id === Number(b.customerId)) : mine[0];
    if (!c) return send(res, 404, { error: "Mijoz topilmadi" });
    const amount = num(b.amount, 1, 1e6), dn = L.parseISO(b.date);
    if (amount === null || dn === null) return send(res, 400, { error: "Summa yoki sana noto'g'ri" });
    if (dn > L.todayNum() + 1) return send(res, 400, { error: "Kelajak sanasi bo'lmaydi" });
    if (!okPhoto(b.photo)) return send(res, 400, { error: "To'lov rasmi kerak" });
    if (q.payPending.get(c.id).n >= 5) return send(res, 400, { error: "Tasdiqlanmagan to'lovlar ko'p. Sotuvchi tasdiqlashini kuting" });
    const r = q.payInsert.run(c.id, b.date, amount, "wait", "pay", b.photo, new Date().toISOString());
    notifySellers(`Yangi to'lov: ${c.name}, ${L.usd(amount)} (${b.date}). Chek rasmini tekshirib, tasdiqlang.`);
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }

  mm = /^\/api\/payments\/(\d+)\/(confirm|reject)$/.exec(p);
  if (mm && m === "POST") {
    if (!seller) return send(res, 403, { error: "Faqat sotuvchi" });
    const pay = q.payGet.get(Number(mm[1]));
    if (!pay) return send(res, 404, { error: "Topilmadi" });
    const status = mm[2] === "confirm" ? "ok" : "no";
    const r = q.payDecide.run(status, new Date().toISOString(), pay.id);
    if (!r.changes) return send(res, 409, { error: "Bu to'lov allaqachon ko'rib chiqilgan" });
    const c = q.custGet.get(pay.customer_id);
    notify(c && c.tg_id, status === "ok"
      ? `To'lovingiz tasdiqlandi: ${L.usd(pay.amount)} (${pay.date}). Rahmat!`
      : `To'lovingiz (${L.usd(pay.amount)}, ${pay.date}) tasdiqlanmadi. Sotuvchi bilan bog'laning.`, true);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Topilmadi" });
}

// ---------- server ----------
const INDEX = path.join(__dirname, "public", "index.html");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(fs.readFileSync(INDEX));
    }
    res.writeHead(404); res.end("Topilmadi");
  } catch (e) {
    console.error("So'rov xatosi:", e.message);
    if (!res.headersSent) send(res, e.message === "katta" ? 413 : 400, { error: e.message === "katta" ? "Rasm juda katta" : "Noto'g'ri so'rov" });
  }
});

// ---------- bot ----------
const NOTFOUND = "Bu raqam bo'yicha mijoz topilmadi. Raqamingiz sotuvchida kiritilganini tekshiring, so'ng /start ni qayta bosing.";
async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || !msg.from || msg.chat.type !== "private") return;
  const from = msg.from, chatId = msg.chat.id;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");

  if (msg.contact) {
    if (msg.contact.user_id !== from.id) return notify(chatId, "Iltimos, o'zingizning raqamingizni tugma orqali yuboring.");
    const p9 = phone9(msg.contact.phone_number);
    const now = new Date().toISOString();
    if (CFG.sellerPhones.includes(p9)) {
      q.userUpsert.run(from.id, "seller", name, p9, now);
      await tg("sendMessage", { chat_id: chatId, text: "Xush kelibsiz! Siz sotuvchi sifatida kirdingiz.", reply_markup: { remove_keyboard: true } });
    } else if (q.custFindPhone.all(p9, from.id).length) {
      q.custLink.run(from.id, p9, from.id);
      q.userUpsert.run(from.id, "customer", name, p9, now);
      await tg("sendMessage", { chat_id: chatId, text: "Xush kelibsiz! Hisobingiz topildi.", reply_markup: { remove_keyboard: true } });
    } else {
      return tg("sendMessage", { chat_id: chatId, text: NOTFOUND, reply_markup: { remove_keyboard: true } });
    }
    if (CFG.appUrl) await tg("setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "Nasiya hisobi", web_app: { url: CFG.appUrl } } });
    return notify(chatId, "Ilovani ochish uchun tugmani bosing.", true);
  }

  if (msg.text && msg.text.startsWith("/start")) {
    const u2 = q.userGet.get(from.id);
    if (u2) {
      // mijoz keyin qo'shilgan bo'lishi mumkin: raqam bo'yicha qayta bog'laymiz
      if (u2.role === "customer" && u2.phone9) q.custLink.run(from.id, u2.phone9, from.id);
      return notify(chatId, "Ilovani ochish uchun tugmani bosing.", true);
    }
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Assalomu alaykum! Nasiya hisobi ilovasiga kirish uchun telefon raqamingizni yuboring (pastdagi tugma).",
      reply_markup: { keyboard: [[{ text: "Raqamni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }
  if (msg.text) return notify(chatId, "Ilovani ochish uchun /start ni bosing.");
}

let polling = false;
async function pollLoop() {
  if (!CFG.token || polling) return;
  polling = true;
  await tg("deleteWebhook", {});
  let offset = Number((q.metaGet.get("tg_offset") || {}).v || 0);
  for (;;) {
    const r = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    if (!r.ok) { await new Promise((s) => setTimeout(s, 5000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      try { await handleUpdate(u); } catch (e) { console.error("Bot xatosi:", e.message); }
    }
    if (r.result.length) q.metaSet.run("tg_offset", String(offset));
  }
}

// ---------- eslatmalar ----------
// Mijoz va sotuvchiga: to'lovga 10 va 5 kun qolganda; to'lov kuni; kechikkanda (1-kun va har 7 kunda).
async function runReminders(todayNum) {
  const t = todayNum === undefined ? L.todayNum() : todayNum;
  const out = [];
  for (const c of q.custAll.all()) {
    const pays = q.payList.all(c.id);
    const i = L.info(c, pays, t);
    if (i.left <= 0) continue;
    let kind = null, cust = "", sel = "";
    const due = L.labelOfDayNum(i.nd), car = `${c.car || "Mashina"} ${c.plate || ""}`.trim();
    if (i.days === 10 || i.days === 5) {
      kind = "d" + i.days;
      cust = `Eslatma: ${car} bo'yicha nasiya to'lovingizga ${i.days} kun qoldi (${due}). To'lov: ${L.usd(i.next)}. To'lovni ilovada chek rasmi bilan kiriting.`;
      sel = `${c.name}: to'lovga ${i.days} kun qoldi (${due}), ${L.usd(i.next)}.`;
    } else if (i.days === 0) {
      kind = "d0";
      cust = `Bugun nasiya to'lov kuni (${car}). To'lov: ${L.usd(i.next)}. To'lovni ilovada chek rasmi bilan kiriting.`;
      sel = `${c.name}: bugun to'lov kuni, ${L.usd(i.next)}.`;
    } else if (i.late && (-i.days) % 7 === 1) {
      kind = "late" + (-i.days);
      cust = `Diqqat: ${car} bo'yicha to'lov ${-i.days} kun kechikdi. Qarz: ${L.usd(i.owed)} (${i.lateM} oy). Iltimos, to'lovni amalga oshiring.`;
      sel = `${c.name}: ${-i.days} kun kechikdi, qarz ${L.usd(i.owed)} (${i.lateM} oy). Tel: ${c.phone || "yo'q"}`;
    }
    if (!kind) continue;
    const r = q.remInsert.run(c.id, L.isoOfDayNum(i.nd), kind, new Date().toISOString());
    if (!r.changes) continue; // allaqachon yuborilgan
    out.push({ customer: c.id, kind, cust, sel });
    await notify(c.tg_id, cust, true);
    await notifySellers(sel);
  }
  return out;
}

async function reminderTick() {
  try {
    const now = L.tashkentNow();
    const today = L.isoOfDayNum(L.todayNum(now));
    if (now.getUTCHours() < CFG.reminderHour) return;
    const last = (q.metaGet.get("reminder_date") || {}).v;
    if (last === today) return;
    q.metaSet.run("reminder_date", today);
    const sent = await runReminders();
    console.log(`Eslatmalar: ${sent.length} ta yuborildi (${today})`);
  } catch (e) { console.error("Eslatma xatosi:", e.message); }
}

// ---------- ishga tushirish ----------
function start() {
  server.listen(CFG.port, () => {
    console.log(`Server ishga tushdi: port ${CFG.port}${CFG.dev ? " (DEV rejim)" : ""}`);
    if (!CFG.token) console.log("Diqqat: BOT_TOKEN kiritilmagan, bot va kirish ishlamaydi.");
    if (!CFG.appUrl) console.log("Diqqat: APP_URL kiritilmagan, Telegram ichida ochish tugmasi chiqmaydi.");
    if (!CFG.sellerPhones.length) console.log("Diqqat: SELLER_PHONES kiritilmagan, sotuvchi aniqlanmaydi.");
  });
  if (CFG.token && CFG.appUrl) tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Nasiya hisobi", web_app: { url: CFG.appUrl } } });
  pollLoop();
  setInterval(reminderTick, 10 * 60 * 1000);
  setTimeout(reminderTick, 15 * 1000);
}

if (require.main === module) start();
module.exports = { server, db, q, runReminders, verifyInitData, handleUpdate, CFG, phone9 };
