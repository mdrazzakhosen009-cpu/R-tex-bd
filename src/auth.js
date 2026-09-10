const crypto = require('crypto');
const { exec } = require('../db');

const COOKIE = 'tw_admin';
const SESSION_HOURS = 8;

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function newCsrf() { return crypto.randomBytes(24).toString('hex'); }

async function createSession(adminId) {
  const token = randomToken();
  const csrf = newCsrf();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  await exec('DELETE FROM admin_sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  await exec('INSERT INTO admin_sessions(token_hash,admin_id,csrf_token,expires_at) VALUES(?,?,?,?)', [hashToken(token), adminId, csrf, expires]);
  return { token, csrf, expires };
}

async function getSession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const r = await exec(`SELECT s.*,a.email FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?`, [hashToken(token), new Date().toISOString()]);
  return r.rows[0] || null;
}

async function requireAdmin(req,res,next) {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    req.adminSession = session;
    req.admin = { id: Number(session.admin_id), email: session.email };
    next();
  } catch { res.status(500).json({ error: 'Authentication service unavailable' }); }
}

function csrf(req,res,next) {
  const header = req.get('x-csrf-token');
  if (!header || header !== req.adminSession.csrf_token) return res.status(403).json({ error: 'Invalid security token' });
  next();
}

async function destroySession(req) {
  const token = req.cookies?.[COOKIE];
  if (token) await exec('DELETE FROM admin_sessions WHERE token_hash=?', [hashToken(token)]);
}

function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'lax', maxAge:SESSION_HOURS*3600_000, path:'/' });
}
function clearCookie(res) { res.clearCookie(COOKIE, { httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'lax', path:'/' }); }

module.exports = { createSession, getSession, requireAdmin, csrf, destroySession, setCookie, clearCookie, SESSION_HOURS };
