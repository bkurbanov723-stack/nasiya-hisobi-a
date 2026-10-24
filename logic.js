"use strict";
// Hisob-kitob mantiqi. Server va testlar shu fayldan foydalanadi.
// Barcha sanalar "kun raqami" ko'rinishida (1970-yil 1-yanvardan beri o'tgan kunlar),
// shuning uchun vaqt zonasi va yozgi/qishki vaqt xatolik keltirmaydi.

const MON = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const TZ_OFFSET_HOURS = 5; // Toshkent, UTC+5

function dayNum(y, m, d) { return Math.round(Date.UTC(y, m, d) / 864e5); }

function tashkentNow() { return new Date(Date.now() + TZ_OFFSET_HOURS * 3600e3); }

function todayNum(now) {
  const t = now || tashkentNow();
  return dayNum(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

function isoOfDayNum(n) { return new Date(n * 864e5).toISOString().slice(0, 10); }

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const n = dayNum(y, mo, d);
  return isoOfDayNum(n) === s ? n : null;
}

function labelOfDayNum(n) {
  const dt = new Date(n * 864e5);
  return dt.getUTCDate() + "-" + MON[dt.getUTCMonth()];
}

// k-chi oylik to'lovning muddati (k = 1, 2, ...)
function dueNum(c, k) {
  const p = String(c.start).split("-");
  const m0 = Number(p[1]) - 1 + k - 1;
  const y = Number(p[0]) + Math.floor(m0 / 12);
  const m = ((m0 % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return dayNum(y, m, Math.min(Number(c.day), dim));
}

// c: mijoz, pays: [{amount, status}], today: kun raqami
function info(c, pays, today) {
  let paid = 0, pend = 0;
  for (const p of pays) {
    if (p.status === "ok") paid += p.amount;
    else if (p.status === "wait") pend++;
  }
  const mo = c.total / c.months;
  const pn = Math.floor(paid / mo + 1e-4);
  const left = Math.max(c.total - paid, 0);
  let dcStrict = 0, dcIncl = 0;
  for (let q = 1; q <= c.months; q++) {
    const d = dueNum(c, q);
    if (d < today) dcStrict++;
    if (d <= today) dcIncl++;
  }
  const nd = dueNum(c, Math.min(pn + 1, c.months));
  const days = nd - today;
  const late = left > 0 && dcStrict > pn;
  let next = Math.min(left, Math.max(mo * (pn + 1) - paid, 0));
  if (left > 0 && next < 1) next = Math.min(mo, left);
  return {
    paid, left, mo, pn, nd, days, late, next, pend,
    pm: paid / mo,
    owed: Math.min(left, Math.max(mo * dcStrict - paid, 0)),
    lateM: Math.max(dcStrict - pn, 0),
    ahead: Math.max(pn - dcIncl, 0),
  };
}

function usd(n) { return Math.round(n).toLocaleString("en-US").replace(/,/g, " ") + " $"; }

module.exports = { MON, dayNum, tashkentNow, todayNum, isoOfDayNum, parseISO, labelOfDayNum, dueNum, info, usd };
