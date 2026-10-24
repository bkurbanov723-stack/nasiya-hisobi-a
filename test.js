"use strict";
// Avtomatik tekshiruv: node test.js
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nasiya-test-"));
process.env.DB_PATH = path.join(tmp, "t.db");
process.env.DEV = "1";
process.env.BOT_TOKEN = "";
process.env.SELLER_PHONES = "944559955";
process.env.APP_URL = "";

const L = require("./logic");
const S = require("./server");

let passed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log("  ok  " + name); },
    (e) => { console.error("  XATO  " + name + "\n" + e.stack); process.exitCode = 1; });
}

const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

(async () => {
  console.log("Hisob-kitob mantiqi");
  const t = (y, m, d) => L.dayNum(y, m - 1, d);
  await ok("kechikkan mijoz (daftar misoli)", () => {
    const c = { day: 3, start: "2025-11", total: 9040, months: 24 };
    const pays = [450, 400, 400, 400, 400, 500, 400].map((a) => ({ amount: a, status: "ok" }));
    const i = L.info(c, pays, t(2026, 10, 24));
    assert.equal(i.paid, 2950);
    assert.equal(Math.round(i.left), 6090);
    assert.equal(i.pn, 7);
    assert.equal(i.late, true);
    assert.equal(i.days, -143);
    assert.equal(i.lateM, 5);
    assert.equal(Math.round(i.owed), 1570);
  });
  await ok("tasdiqlanmagan to'lov hisobga kirmaydi", () => {
    const c = { day: 15, start: "2026-10", total: 4800, months: 24 };
    const i = L.info(c, [{ amount: 200, status: "ok" }, { amount: 500, status: "wait" }, { amount: 300, status: "no" }], t(2026, 10, 24));
    assert.equal(i.paid, 200);
    assert.equal(i.pend, 1);
  });
  await ok("kechikmagan mijoz", () => {
    const c = { day: 28, start: "2026-09", total: 7200, months: 24 };
    const i = L.info(c, [{ amount: 300, status: "ok" }, { amount: 300, status: "ok" }], t(2026, 10, 24));
    assert.equal(i.pn, 2);
    assert.equal(i.late, false);
    assert.equal(i.days, 35);
  });
  await ok("oldindan to'lov", () => {
    const c = { day: 15, start: "2026-10", total: 9040, months: 24 };
    const i = L.info(c, [{ amount: 1200, status: "ok" }], t(2026, 10, 24));
    assert.equal(i.pn, 3);
    assert.equal(i.ahead, 2);
    assert.equal(i.late, false);
  });
  await ok("to'liq to'langan", () => {
    const c = { day: 3, start: "2025-01", total: 2400, months: 24 };
    const i = L.info(c, [{ amount: 2400, status: "ok" }], t(2026, 10, 24));
    assert.equal(i.left, 0);
    assert.equal(i.late, false);
  });
  await ok("oy oxirgi kuni (31-fevral -> 28-fevral)", () => {
    const c = { day: 31, start: "2026-02" };
    assert.equal(L.dueNum(c, 1), t(2026, 2, 28));
    assert.equal(L.dueNum(c, 2), t(2026, 3, 31));
    assert.equal(L.dueNum({ day: 31, start: "2028-02" }, 1), t(2028, 2, 29));
  });
  await ok("yil almashishi", () => {
    assert.equal(L.dueNum({ day: 10, start: "2026-11" }, 3), t(2027, 1, 10));
  });

  console.log("Telegram kirish tekshiruvi");
  const TOKEN = "123456:TEST-TOKEN";
  function makeInit(user, authDate, token) {
    const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAA", user: JSON.stringify(user) });
    const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
    return p.toString();
  }
  S.CFG.token = TOKEN;
  const nowS = Math.floor(Date.now() / 1000);
  await ok("to'g'ri imzo qabul qilinadi", () => {
    const u = S.verifyInitData(makeInit({ id: 77, first_name: "Ali" }, nowS, TOKEN));
    assert.equal(u.id, 77);
  });
  await ok("o'zgartirilgan ma'lumot rad etiladi", () => {
    const init = makeInit({ id: 77, first_name: "Ali" }, nowS, TOKEN).replace("%22id%22%3A77", "%22id%22%3A1");
    assert.equal(S.verifyInitData(init), null);
  });
  await ok("boshqa token bilan imzolangani rad etiladi", () => {
    assert.equal(S.verifyInitData(makeInit({ id: 77 }, nowS, "999:OTHER")), null);
  });
  await ok("eskirgan imzo rad etiladi", () => {
    assert.equal(S.verifyInitData(makeInit({ id: 77 }, nowS - 86400 * 3, TOKEN)), null);
  });
  S.CFG.token = "";

  console.log("API");
  await new Promise((r) => S.server.listen(0, r));
  const base = "http://127.0.0.1:" + S.server.address().port;
  async function call(method, url, user, body) {
    const h = { "content-type": "application/json" };
    if (user) h["x-dev-user"] = String(user);
    const r = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  }
  const SELLER = 1, CUST = 2002, OTHER = 3003, STRANGER = 4004;

  await ok("kirishsiz so'rov rad etiladi", async () => {
    assert.equal((await call("GET", "/api/customers")).status, 401);
  });
  await ok("tanilmagan foydalanuvchi ma'lumot ololmaydi", async () => {
    assert.equal((await call("GET", "/api/me", STRANGER)).body.role, "none");
    assert.equal((await call("GET", "/api/customers", STRANGER)).status, 403);
  });

  // bot orqali sotuvchi kirishi
  const contact = (id, phone, userId) => ({ message: { from: { id, first_name: "T" }, chat: { id, type: "private" }, contact: { phone_number: phone, user_id: userId === undefined ? id : userId } } });
  await ok("sotuvchi raqami orqali tanib olinadi", async () => {
    await S.handleUpdate(contact(SELLER, "+998 94 455 99 55"));
    assert.equal((await call("GET", "/api/me", SELLER)).body.role, "seller");
  });
  await ok("boshqaning kontaktini yuborish ishlamaydi", async () => {
    await S.handleUpdate(contact(STRANGER, "+998944559955", 9999));
    assert.equal((await call("GET", "/api/me", STRANGER)).body.role, "none");
  });

  let cust, cust2;
  await ok("sotuvchi mijoz qo'shadi (oldingi to'lov bilan)", async () => {
    const r = await call("POST", "/api/customers", SELLER, { name: "Test Mijoz", phone: "+998 90 111 22 33", plate: "01 a 123 bc", car: "Labo", day: 3, start: "2026-01", init: 3000, total: 9040, months: 24, paidBefore: 1000 });
    assert.equal(r.status, 200);
    cust = r.body.customer;
    assert.equal(cust.plate, "01A123BC");
    assert.equal(cust.pays.length, 1);
    assert.equal(cust.pays[0].kind, "opening");
    assert.equal(cust.pays[0].status, "ok");
  });
  await ok("noto'g'ri ma'lumot rad etiladi", async () => {
    const bad = { name: "X", phone: "+998901112244", plate: "", car: "", day: 3, start: "2026-01", init: 0, total: 100, months: 12 };
    assert.equal((await call("POST", "/api/customers", SELLER, { ...bad, day: 32 })).status, 400);
    assert.equal((await call("POST", "/api/customers", SELLER, { ...bad, phone: "123" })).status, 400);
    assert.equal((await call("POST", "/api/customers", SELLER, { ...bad, start: "2026-13" })).status, 400);
    assert.equal((await call("POST", "/api/customers", SELLER, { ...bad, months: 0 })).status, 400);
  });
  await ok("mijoz telefon raqami bilan bog'lanadi", async () => {
    await S.handleUpdate(contact(CUST, "998901112233"));
    assert.equal((await call("GET", "/api/me", CUST)).body.role, "customer");
    const r = await call("GET", "/api/customers", CUST);
    assert.equal(r.body.customers.length, 1);
    assert.equal(r.body.customers[0].id, cust.id);
  });
  await ok("raqami kiritilmagan odam mijoz bo'lolmaydi", async () => {
    await S.handleUpdate(contact(OTHER, "+998 99 000 00 00"));
    assert.equal((await call("GET", "/api/me", OTHER)).body.role, "none");
  });
  await ok("mijoz faqat o'zini ko'radi, sotuvchi hammani", async () => {
    const c2 = await call("POST", "/api/customers", SELLER, { name: "Boshqa", phone: "+998 99 000 00 00", plate: "10B456CD", car: "Damas", day: 15, start: "2026-10", init: 1500, total: 4800, months: 24 });
    cust2 = c2.body.customer;
    assert.equal((await call("GET", "/api/customers", SELLER)).body.customers.length, 2);
    assert.equal((await call("GET", "/api/customers", CUST)).body.customers.length, 1);
  });

  let payId;
  await ok("mijoz to'lov kiritadi: tekshiruvda turadi", async () => {
    const r = await call("POST", "/api/payments", CUST, { amount: 400, date: "2026-10-20", photo: JPEG });
    assert.equal(r.status, 200);
    payId = r.body.id;
    const me = (await call("GET", "/api/customers", CUST)).body.customers[0];
    const p = me.pays.find((x) => x.id === payId);
    assert.equal(p.status, "wait");
    const i = L.info(me, me.pays.map((x) => ({ amount: x.amount, status: x.status })), t(2026, 10, 24));
    assert.equal(i.paid, 1000);
    assert.equal(i.pend, 1);
  });
  await ok("rasmsiz yoki noto'g'ri to'lov rad etiladi", async () => {
    assert.equal((await call("POST", "/api/payments", CUST, { amount: 400, date: "2026-10-20" })).status, 400);
    assert.equal((await call("POST", "/api/payments", CUST, { amount: 400, date: "2026-10-20", photo: "data:image/png;base64,AAAA" })).status, 400);
    assert.equal((await call("POST", "/api/payments", CUST, { amount: -5, date: "2026-10-20", photo: JPEG })).status, 400);
    assert.equal((await call("POST", "/api/payments", CUST, { amount: 5, date: "2099-01-01", photo: JPEG })).status, 400);
    assert.equal((await call("POST", "/api/payments", CUST, { amount: 5, date: "2026-02-31", photo: JPEG })).status, 400);
  });
  await ok("sotuvchi to'lov kirita olmaydi", async () => {
    assert.equal((await call("POST", "/api/payments", SELLER, { amount: 400, date: "2026-10-20", photo: JPEG })).status, 403);
  });
  await ok("mijoz o'zi tasdiqlay olmaydi", async () => {
    assert.equal((await call("POST", `/api/payments/${payId}/confirm`, CUST)).status, 403);
  });
  await ok("rasmni faqat egasi va sotuvchi ko'radi", async () => {
    assert.equal((await call("GET", `/api/photo/pay/${payId}`, CUST)).status, 200);
    assert.equal((await call("GET", `/api/photo/pay/${payId}`, SELLER)).status, 200);
    await S.handleUpdate(contact(5005, "+998990000000"));
    assert.equal((await call("GET", `/api/photo/pay/${payId}`, 5005)).status, 404);
    assert.equal((await call("GET", `/api/photo/pay/${payId}`, STRANGER)).status, 403);
  });
  await ok("sotuvchi tasdiqlaydi, ikkinchi marta bo'lmaydi", async () => {
    assert.equal((await call("POST", `/api/payments/${payId}/confirm`, SELLER)).status, 200);
    assert.equal((await call("POST", `/api/payments/${payId}/confirm`, SELLER)).status, 409);
    assert.equal((await call("POST", `/api/payments/${payId}/reject`, SELLER)).status, 409);
    const me = (await call("GET", "/api/customers", CUST)).body.customers[0];
    const i = L.info(me, me.pays.map((x) => ({ amount: x.amount, status: x.status })), t(2026, 10, 24));
    assert.equal(i.paid, 1400);
    assert.equal(i.pend, 0);
  });
  await ok("rad etilgan to'lov hisobga kirmaydi", async () => {
    const id = (await call("POST", "/api/payments", CUST, { amount: 999, date: "2026-10-21", photo: JPEG })).body.id;
    assert.equal((await call("POST", `/api/payments/${id}/reject`, SELLER)).status, 200);
    const me = (await call("GET", "/api/customers", CUST)).body.customers[0];
    assert.equal(me.pays.find((x) => x.id === id).status, "no");
    const i = L.info(me, me.pays.map((x) => ({ amount: x.amount, status: x.status })), t(2026, 10, 24));
    assert.equal(i.paid, 1400);
  });
  await ok("tasdiqlanmagan to'lovlar soni cheklangan", async () => {
    let last;
    for (let k = 0; k < 6; k++) last = await call("POST", "/api/payments", CUST, { amount: 1, date: "2026-10-22", photo: JPEG });
    assert.equal(last.status, 400);
  });
  await ok("sotuvchi sozlamalarni o'zgartiradi, telefon o'zgarsa bog'lanish uziladi", async () => {
    let r = await call("PATCH", `/api/customers/${cust.id}`, SELLER, { day: 10, start: "2026-02" });
    assert.equal(r.status, 200);
    assert.equal(r.body.customer.day, 10);
    assert.equal((await call("PATCH", `/api/customers/${cust.id}`, SELLER, { day: 40 })).status, 400);
    assert.equal((await call("PATCH", `/api/customers/${cust.id}`, CUST, { day: 5 })).status, 403);
    r = await call("PATCH", `/api/customers/${cust.id}`, SELLER, { phone: "+998 90 555 66 77" });
    assert.equal(r.body.customer.linked, false);
    assert.equal((await call("GET", "/api/customers", CUST)).body.customers.length, 0);
  });
  await ok("mashina rasmi saqlanadi", async () => {
    assert.equal((await call("PATCH", `/api/customers/${cust2.id}`, SELLER, { photo: JPEG })).status, 200);
    const r = await call("GET", `/api/photo/car/${cust2.id}`, SELLER);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 4);
    assert.equal((await call("PATCH", `/api/customers/${cust2.id}`, SELLER, { photo: "javascript:alert(1)" })).status, 400);
  });

  console.log("Eslatmalar");
  await ok("10 kun, 5 kun, to'lov kuni va kechikish; takrorlanmaydi", async () => {
    // yangi mijoz: birinchi to'lov muddati 2030-06-15
    const c = (await call("POST", "/api/customers", SELLER, { name: "Eslatma", phone: "+998 91 000 11 22", plate: "01Z999ZZ", car: "Gentra", day: 15, start: "2030-06", init: 0, total: 2400, months: 24 })).body.customer;
    const due = t(2030, 6, 15);
    const kinds = async (day) => (await S.runReminders(day)).filter((x) => x.customer === c.id).map((x) => x.kind);
    assert.deepEqual(await kinds(due - 11), []);
    assert.deepEqual(await kinds(due - 10), ["d10"]);
    assert.deepEqual(await kinds(due - 10), []);
    assert.deepEqual(await kinds(due - 9), []);
    assert.deepEqual(await kinds(due - 5), ["d5"]);
    assert.deepEqual(await kinds(due), ["d0"]);
    assert.deepEqual(await kinds(due + 1), ["late1"]);
    assert.deepEqual(await kinds(due + 2), []);
    assert.deepEqual(await kinds(due + 8), ["late8"]);
  });
  await ok("to'liq to'langan mijozga eslatma ketmaydi", async () => {
    const c = (await call("POST", "/api/customers", SELLER, { name: "Yopilgan", phone: "+998 91 000 33 44", plate: "01Y111YY", car: "Nexia", day: 15, start: "2030-06", init: 0, total: 1200, months: 12, paidBefore: 1200 })).body.customer;
    const out = (await S.runReminders(t(2030, 6, 15) - 10)).filter((x) => x.customer === c.id);
    assert.equal(out.length, 0);
  });

  console.log("\n" + passed + " ta tekshiruv o'tdi" + (process.exitCode ? ", XATOLAR BOR" : ""));
  S.server.close();
  S.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})();
