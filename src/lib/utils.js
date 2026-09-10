const crypto = require('crypto');
function safeInt(v, fallback=0) { const n=Number(v); return Number.isFinite(n)?Math.trunc(n):fallback; }
function safeMoney(v, fallback=0) { const n=Number(v); return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:fallback; }
function slugify(s) { return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || crypto.randomBytes(4).toString('hex'); }
function bool(v) { return v===true||v===1||v==='1'||v==='true'||v==='on'; }
function parseJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function cleanText(v,max=5000) { return String(v ?? '').trim().slice(0,max); }
function validHttpUrl(v) { if(!v) return true; try { const u=new URL(v); return ['http:','https:'].includes(u.protocol); } catch { return false; } }
function normalizePhone(v) { return String(v||'').replace(/[^0-9+]/g,'').slice(0,20); }
function orderCode() { return `TW-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
module.exports={safeInt,safeMoney,slugify,bool,parseJson,cleanText,validHttpUrl,normalizePhone,orderCode};
