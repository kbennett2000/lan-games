/**
 * auth.js
 *
 * Authentication utilities: password hashing, JWT generation/verification,
 * and an Express middleware that protects routes behind a valid token.
 */

'use strict';

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

// ── configuration ─────────────────────────────────────────────────────────────

// JWT_SECRET is guaranteed to be set by the startup pre-flight check in index.js.
// There is intentionally no fallback — an undefined secret causes jwt.sign/verify
// to throw immediately, ensuring misconfiguration is never silently tolerated.
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
// BCRYPT_ROUNDS can be lowered (e.g. to 4) in integration tests for faster hashing.
const SALT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Hash a plaintext password with bcrypt.
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a stored bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Issue a signed JWT containing the user's id and username.
 * @param {{ id: string, username: string }} user
 * @returns {string} signed JWT
 */
function generateToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

/**
 * Verify and decode a JWT.
 * @param {string} token
 * @returns {{ sub: string, username: string }} decoded payload
 * @throws if the token is invalid or expired
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * requireAuth
 *
 * Expects an Authorization header of the form "Bearer <token>".
 * Attaches the decoded payload as req.user on success.
 * Returns 401 on failure.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * optionalAuth
 *
 * Same as requireAuth but does not reject unauthenticated requests.
 * Sets req.user = null when no token is present/valid.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    req.user = verifyToken(token);
  } catch {
    req.user = null;
  }
  next();
}

/**
 * Authenticate a Socket.io connection.
 * Reads the token from socket.handshake.auth.token.
 * Returns the decoded payload or throws.
 */
function authenticateSocket(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) throw new Error('No token provided');
  return verifyToken(token);
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  authenticateSocket,
};
