/**
 * Stats Buffer - Sammelt Stats und schreibt sie periodisch in die DB
 * Standalone Version
 */

const connectDB = require("./connection");

// In-Memory Buffer für Stats
const statsBuffer = new Map();
const FLUSH_INTERVAL = 60000; // Alle 60 Sekunden in DB schreiben

/**
 * Erzeugt einen 10-Minuten-Window-Key für Stats-Aggregation
 */
function getWindowKey(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(Math.floor(d.getMinutes() / 10) * 10);
  d.setSeconds(0);
  d.setMilliseconds(0);
  return d.toISOString();
}

/**
 * Erfasst einen Stat-Eintrag
 */
function recordStat(serviceName, filePath, contentType, bytes, isRangeRequest = false) {
  const windowKey = getWindowKey();
  const key = `${serviceName}|${filePath}|${windowKey}`;

  if (!statsBuffer.has(key)) {
    statsBuffer.set(key, {
      serviceName,
      filePath,
      contentType,
      count: 0,
      trafficBytes: 0,
      windowStart: new Date(windowKey),
      createdAt: new Date(),
    });
  }

  const entry = statsBuffer.get(key);
  entry.count += 1;
  entry.trafficBytes += bytes || 0;
}

/**
 * Schreibt alle gepufferten Stats in die Datenbank
 */
async function flushStats() {
  if (statsBuffer.size === 0) return;

  try {
    const db = await connectDB();
    const statsCollection = db.collection("stats");

    const entries = Array.from(statsBuffer.values());
    statsBuffer.clear();

    const bulkOps = entries.map((entry) => ({
      updateOne: {
        filter: {
          serviceName: entry.serviceName,
          filePath: entry.filePath,
          windowStart: entry.windowStart,
        },
        update: {
          $inc: {
            count: entry.count,
            trafficBytes: entry.trafficBytes,
          },
          $setOnInsert: {
            contentType: entry.contentType,
            createdAt: entry.createdAt,
          },
        },
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      await statsCollection.bulkWrite(bulkOps, { ordered: false });
      console.log(`[STATS] Flushed ${bulkOps.length} stat entries to database`);
    }
  } catch (err) {
    console.error("[STATS] Error flushing stats:", err);
  }
}

// Periodisch Stats in DB schreiben
setInterval(flushStats, FLUSH_INTERVAL);

// Bei Prozessbeendigung noch ausstehende Stats schreiben
process.on("SIGINT", async () => {
  console.log("[STATS] Flushing stats before exit...");
  await flushStats();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[STATS] Flushing stats before exit...");
  await flushStats();
  process.exit(0);
});

/**
 * Holt Stats für einen Service aus der Datenbank
 */
async function getStats(serviceName, options = {}) {
  const db = await connectDB();
  const statsCollection = db.collection("stats");

  const { hours = 24, limit = 100 } = options;

  const since = new Date();
  since.setHours(since.getHours() - hours);

  const query = {
    serviceName,
    windowStart: { $gte: since },
  };

  const stats = await statsCollection
    .find(query)
    .sort({ windowStart: -1 })
    .limit(limit)
    .toArray();

  return stats;
}

/**
 * Holt aggregierte Stats für einen Service
 */
async function getServiceSummary(serviceName) {
  const db = await connectDB();
  const statsCollection = db.collection("stats");

  const pipeline = [
    { $match: { serviceName } },
    {
      $group: {
        _id: "$serviceName",
        totalRequests: { $sum: "$count" },
        totalTraffic: { $sum: "$trafficBytes" },
        uniqueFiles: { $addToSet: "$filePath" },
      },
    },
    {
      $project: {
        serviceName: "$_id",
        totalRequests: 1,
        totalTraffic: 1,
        uniqueFileCount: { $size: "$uniqueFiles" },
      },
    },
  ];

  const result = await statsCollection.aggregate(pipeline).toArray();
  return result[0] || { serviceName, totalRequests: 0, totalTraffic: 0, uniqueFileCount: 0 };
}

/**
 * Holt Stats für alle Services (Dashboard)
 */
async function getAllServicesSummary() {
  const db = await connectDB();
  const statsCollection = db.collection("stats");

  const pipeline = [
    {
      $group: {
        _id: "$serviceName",
        totalRequests: { $sum: "$count" },
        totalTraffic: { $sum: "$trafficBytes" },
      },
    },
    {
      $project: {
        serviceName: "$_id",
        totalRequests: 1,
        totalTraffic: 1,
      },
    },
    { $sort: { totalTraffic: -1 } },
  ];

  return await statsCollection.aggregate(pipeline).toArray();
}

/**
 * Holt Traffic-Verlauf für einen Service (für Charts)
 */
async function getTrafficHistory(serviceName, hours = 24) {
  const db = await connectDB();
  const statsCollection = db.collection("stats");

  const since = new Date();
  since.setHours(since.getHours() - hours);

  const pipeline = [
    {
      $match: {
        serviceName,
        windowStart: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$windowStart",
        requests: { $sum: "$count" },
        traffic: { $sum: "$trafficBytes" },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        timestamp: "$_id",
        requests: 1,
        traffic: 1,
      },
    },
  ];

  return await statsCollection.aggregate(pipeline).toArray();
}

module.exports = {
  recordStat,
  flushStats,
  getStats,
  getServiceSummary,
  getAllServicesSummary,
  getTrafficHistory,
};
