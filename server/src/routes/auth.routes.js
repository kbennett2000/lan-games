/**
 * auth.routes.js
 *
 * REST endpoints for user registration and login.
 *
 *   POST /api/auth/register  — create a new account
 *   POST /api/auth/login     — sign in and receive a JWT
 *   GET  /api/auth/me        — return the current user's profile (token required)
 */

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const auth     = require('../auth');
const database = require('../database');

const router = express.Router();

// ── POST /api/auth/register ──────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password is required' });
  }
  if (username.length < 2 || username.length > 24) {
    return res.status(400).json({ error: 'username must be 2–24 characters' });
  }
  if (!/^[a-zA-Z0-9_\- ]+$/.test(username)) {
    return res.status(400).json({ error: 'username may only contain letters, numbers, spaces, hyphens, and underscores' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }

  if (database.getUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  try {
    const id           = uuidv4();
    const passwordHash = await auth.hashPassword(password);
    database.createUser(id, username, passwordHash);

    const token = auth.generateToken({ id, username });
    res.status(201).json({ token, user: { id, username } });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = database.getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  try {
    const valid = await auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = auth.generateToken({ id: user.id, username: user.username });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

router.get('/me', auth.requireAuth, (req, res) => {
  const user = database.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username });
});

module.exports = router;
