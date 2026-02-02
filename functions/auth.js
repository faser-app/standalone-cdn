/**
 * Simple Auth Middleware für Standalone Version
 * Verwendet Username/Password aus .env
 */

require("dotenv").config();
const crypto = require("crypto");

// Session-Store (in-memory für Standalone)
const sessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 Stunden

/**
 * Generiert einen sicheren Session-Token
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Prüft ob die Credentials korrekt sind
 */
function validateCredentials(username, password) {
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;

  if (!envUsername || !envPassword) {
    console.error("[AUTH] ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env");
    return false;
  }

  return username === envUsername && password === envPassword;
}

/**
 * Prüft ob ein Session-Token gültig ist
 */
function validateSession(sessionToken) {
  if (!sessionToken) return false;

  const session = sessions.get(sessionToken);
  if (!session) return false;

  // Prüfe ob Session abgelaufen ist
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionToken);
    return false;
  }

  // Aktualisiere letzte Aktivität
  session.lastActivity = Date.now();
  return true;
}

/**
 * Auth Middleware - prüft ob Request authentifiziert ist
 */
function authMiddleware(req, res, next) {
  // Session-Token aus Header oder Body
  const sessionToken = req.headers["x-session-token"] || req.body?.sessionToken;

  if (!validateSession(sessionToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

/**
 * POST /auth/login
 * Body: { username, password }
 */
async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  if (!validateCredentials(username, password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Session erstellen
  const sessionToken = generateSessionToken();
  const session = {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION,
    lastActivity: Date.now(),
  };

  sessions.set(sessionToken, session);

  res.json({
    success: true,
    sessionToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}

/**
 * POST /auth/logout
 * Header: x-session-token
 */
async function logout(req, res) {
  const sessionToken = req.headers["x-session-token"] || req.body?.sessionToken;

  if (sessionToken) {
    sessions.delete(sessionToken);
  }

  res.json({ success: true });
}

/**
 * POST /auth/check
 * Prüft ob Session gültig ist
 */
async function checkAuth(req, res) {
  const sessionToken = req.headers["x-session-token"] || req.body?.sessionToken;

  if (validateSession(sessionToken)) {
    const session = sessions.get(sessionToken);
    res.json({
      authenticated: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } else {
    res.json({ authenticated: false });
  }
}

/**
 * GET /auth/me
 * Gibt User-Info zurück
 */
async function me(req, res) {
  const sessionToken = req.headers["x-session-token"] || req.body?.sessionToken;

  if (!validateSession(sessionToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const session = sessions.get(sessionToken);
  res.json({
    username: session.username,
    createdAt: new Date(session.createdAt).toISOString(),
  });
}

module.exports = {
  authMiddleware,
  login,
  logout,
  checkAuth,
  me,
  validateSession,
};
