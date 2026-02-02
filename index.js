const express = require("express");
const cors = require("cors");
const { CronJob } = require("cron");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

// Import functions
const getFile = require("./functions/getFile");
const checkExpiredFiles = require("./functions/checkExpiredFiles");
const { authMiddleware, login, logout, checkAuth, me } = require("./functions/auth");
const {
  createService,
  deleteService,
  updateService,
  updateServers,
  listServices,
  getService,
  clearServiceCache,
  servicesSummary,
} = require("./functions/serviceManagement");
const {
  getStats,
  getServiceSummary,
  getAllServicesSummary,
  getTrafficHistory,
} = require("./functions/statsBuffer");

// ============================================
// Public Routes (keine Auth erforderlich)
// ============================================

app.get("/", function (req, res) {
  res.send("OK");
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ============================================
// Auth Routes
// ============================================

app.post("/auth/login", login);
app.post("/auth/logout", logout);
app.post("/auth/check", checkAuth);
app.post("/auth/me", me);

// ============================================
// Protected API Routes (Auth erforderlich)
// ============================================

// Service Management
app.post("/service/create", authMiddleware, createService);
app.post("/service/delete", authMiddleware, deleteService);
app.post("/service/update", authMiddleware, updateService);
app.post("/service/servers", authMiddleware, updateServers);
app.post("/service/get", authMiddleware, getService);
app.post("/service/clear", authMiddleware, clearServiceCache);

// Services List & Summary
app.post("/services/list", authMiddleware, listServices);
app.post("/services/summary", authMiddleware, servicesSummary);

// Stats API
app.post("/stats/service", authMiddleware, async (req, res) => {
  const { serviceName, hours } = req.body;
  if (!serviceName) {
    return res.status(400).json({ error: "serviceName is required" });
  }
  const stats = await getStats(serviceName, { hours: hours || 24 });
  res.json({ success: true, stats });
});

app.post("/stats/summary", authMiddleware, async (req, res) => {
  const { serviceName } = req.body;
  if (!serviceName) {
    return res.status(400).json({ error: "serviceName is required" });
  }
  const summary = await getServiceSummary(serviceName);
  res.json({ success: true, summary });
});

app.post("/stats/all", authMiddleware, async (req, res) => {
  const summary = await getAllServicesSummary();
  res.json({ success: true, summary });
});

app.post("/stats/history", authMiddleware, async (req, res) => {
  const { serviceName, hours } = req.body;
  if (!serviceName) {
    return res.status(400).json({ error: "serviceName is required" });
  }
  const history = await getTrafficHistory(serviceName, hours || 24);
  res.json({ success: true, history });
});

// ============================================
// CDN File Serving (muss am Ende stehen!)
// ============================================

app.get("/:service/*name", getFile);

// ============================================
// Cron Jobs
// ============================================

const checkExpiredFilesCron = new CronJob(
  "*/10 * * * *",
  checkExpiredFiles,
  null,
  true,
  "America/Los_Angeles"
);

// ============================================
// Start Server
// ============================================

const PORT = process.env.PORT || 3200;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           🚀 CDN Server (Standalone)                 ║
╠══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                          ║
║  Auth: Username/Password from .env                   ║
╚══════════════════════════════════════════════════════╝
  `);

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.warn("⚠️  WARNING: ADMIN_USERNAME and ADMIN_PASSWORD not set in .env!");
    console.warn("   API routes will not be accessible without authentication.");
  }
});
