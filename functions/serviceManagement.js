/**
 * Service Management - Standalone Version
 */

const connectDB = require("./connection");
const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
  endpoint: process.env.CACHE_URL,
  accessKeyId: process.env.CACHE_USERNAME,
  secretAccessKey: process.env.CACHE_PASSWORD,
  s3ForcePathStyle: true,
});

/**
 * Validiert einen Service-Namen
 */
function isValidServiceName(name) {
  if (!name || typeof name !== "string") return false;
  const regex = /^[a-zA-Z0-9-]+$/;
  return regex.test(name) && name.length >= 2 && name.length <= 64;
}

/**
 * POST /service/create
 * Body: { serviceName }
 */
async function createService(req, res) {
  const { serviceName } = req.body;

  if (!serviceName) {
    return res.status(400).json({ error: "serviceName is required" });
  }

  if (!isValidServiceName(serviceName)) {
    return res.status(400).json({
      error: "Service name can only contain letters, numbers and dashes (2-64 chars)",
    });
  }

  const db = await connectDB();
  const services = db.collection("services");

  // Prüfe ob Name bereits verwendet wird
  const existing = await services.findOne({
    name: serviceName.toLowerCase(),
    active: true,
  });

  if (existing) {
    return res.status(400).json({ error: "Service name already in use" });
  }

  const serviceId = Math.floor(Math.random() * 10000000);

  const service = {
    name: serviceName.toLowerCase(),
    id: serviceId,
    maxStorage: 1000,
    daysCached: 30,
    serverAddresses: [],
    createdAt: new Date().toISOString(),
    active: true,
  };

  await services.insertOne(service);

  res.json({
    success: true,
    service: {
      name: service.name,
      id: service.id,
      daysCached: service.daysCached,
      serverAddresses: service.serverAddresses,
      createdAt: service.createdAt,
    },
  });
}

/**
 * POST /service/delete
 * Body: { serviceId } oder { serviceName }
 */
async function deleteService(req, res) {
  const { serviceId, serviceName } = req.body;

  if (!serviceId && !serviceName) {
    return res.status(400).json({ error: "serviceId or serviceName is required" });
  }

  const db = await connectDB();
  const services = db.collection("services");
  const cache = db.collection("cache");

  const query = serviceId
    ? { id: parseInt(serviceId, 10), active: true }
    : { name: serviceName.toLowerCase(), active: true };

  const service = await services.findOne(query);

  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  // Soft delete
  await services.updateOne(
    { _id: service._id },
    {
      $set: {
        active: false,
        deactivatedAt: new Date().toISOString(),
      },
    }
  );

  // Lösche gecachte Dateien
  const cachedFiles = await cache.find({ serviceId: service.id }).toArray();

  for (const file of cachedFiles) {
    try {
      if (file.storage?.key) {
        await s3.deleteObject({ Bucket: "cache", Key: file.storage.key }).promise();
      }
    } catch (err) {
      console.error(`Error deleting cached file: ${file.storage?.key}`, err);
    }
  }

  await cache.deleteMany({ serviceId: service.id });

  res.json({
    success: true,
    message: `Service "${service.name}" deleted`,
    filesDeleted: cachedFiles.length,
  });
}

/**
 * POST /service/update
 * Body: { serviceId, daysCached }
 */
async function updateService(req, res) {
  const { serviceId, serviceName, daysCached } = req.body;

  if (!serviceId && !serviceName) {
    return res.status(400).json({ error: "serviceId or serviceName is required" });
  }

  const db = await connectDB();
  const services = db.collection("services");

  const query = serviceId
    ? { id: parseInt(serviceId, 10), active: true }
    : { name: serviceName.toLowerCase(), active: true };

  const service = await services.findOne(query);

  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  const updates = {};

  if (daysCached !== undefined) {
    const days = parseInt(daysCached, 10);
    if (days < 1 || days > 365) {
      return res.status(400).json({ error: "daysCached must be between 1 and 365" });
    }
    updates.daysCached = days;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid updates provided" });
  }

  await services.updateOne({ _id: service._id }, { $set: updates });

  res.json({
    success: true,
    service: {
      ...service,
      ...updates,
    },
  });
}

/**
 * POST /service/servers
 * Body: { serviceId, serverAddresses: [...] }
 */
async function updateServers(req, res) {
  const { serviceId, serviceName, serverAddresses } = req.body;

  if (!serviceId && !serviceName) {
    return res.status(400).json({ error: "serviceId or serviceName is required" });
  }

  if (!Array.isArray(serverAddresses)) {
    return res.status(400).json({ error: "serverAddresses must be an array" });
  }

  // Validiere URLs
  const validAddresses = serverAddresses
    .filter((addr) => typeof addr === "string" && addr.trim())
    .map((addr) => addr.trim())
    .slice(0, 10); // Max 10 Server

  const db = await connectDB();
  const services = db.collection("services");

  const query = serviceId
    ? { id: parseInt(serviceId, 10), active: true }
    : { name: serviceName.toLowerCase(), active: true };

  const service = await services.findOne(query);

  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  await services.updateOne(
    { _id: service._id },
    { $set: { serverAddresses: validAddresses } }
  );

  res.json({
    success: true,
    serverAddresses: validAddresses,
  });
}

/**
 * POST /services/list
 * Listet alle Services auf
 */
async function listServices(req, res) {
  const db = await connectDB();
  const services = db.collection("services");
  const cache = db.collection("cache");

  const allServices = await services.find({ active: true }).toArray();

  // Füge Usage-Stats hinzu
  const servicesWithUsage = await Promise.all(
    allServices.map(async (service) => {
      const cacheStats = await cache
        .aggregate([
          { $match: { serviceId: service.id } },
          {
            $group: {
              _id: null,
              fileCount: { $sum: 1 },
              totalBytes: { $sum: "$sizeBytes" },
            },
          },
        ])
        .toArray();

      const usage = cacheStats[0] || { fileCount: 0, totalBytes: 0 };

      return {
        name: service.name,
        id: service.id,
        daysCached: service.daysCached,
        serverAddresses: service.serverAddresses,
        createdAt: service.createdAt,
        usage: {
          fileCount: usage.fileCount,
          totalBytes: usage.totalBytes,
        },
      };
    })
  );

  res.json({
    success: true,
    services: servicesWithUsage,
  });
}

/**
 * POST /service/get
 * Holt Details eines Services
 * Body: { serviceId } oder { serviceName }
 */
async function getService(req, res) {
  const { serviceId, serviceName } = req.body;

  if (!serviceId && !serviceName) {
    return res.status(400).json({ error: "serviceId or serviceName is required" });
  }

  const db = await connectDB();
  const services = db.collection("services");
  const cache = db.collection("cache");

  const query = serviceId
    ? { id: parseInt(serviceId, 10), active: true }
    : { name: serviceName.toLowerCase(), active: true };

  const service = await services.findOne(query);

  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  // Usage Stats
  const cacheStats = await cache
    .aggregate([
      { $match: { serviceId: service.id } },
      {
        $group: {
          _id: null,
          fileCount: { $sum: 1 },
          totalBytes: { $sum: "$sizeBytes" },
        },
      },
    ])
    .toArray();

  const usage = cacheStats[0] || { fileCount: 0, totalBytes: 0 };

  res.json({
    success: true,
    service: {
      name: service.name,
      id: service.id,
      daysCached: service.daysCached,
      serverAddresses: service.serverAddresses,
      createdAt: service.createdAt,
      usage: {
        fileCount: usage.fileCount,
        totalBytes: usage.totalBytes,
      },
    },
  });
}

/**
 * POST /service/clear
 * Löscht alle gecachten Dateien eines Services
 */
async function clearServiceCache(req, res) {
  const { serviceId, serviceName } = req.body;

  if (!serviceId && !serviceName) {
    return res.status(400).json({ error: "serviceId or serviceName is required" });
  }

  const db = await connectDB();
  const services = db.collection("services");
  const cache = db.collection("cache");

  const query = serviceId
    ? { id: parseInt(serviceId, 10), active: true }
    : { name: serviceName.toLowerCase(), active: true };

  const service = await services.findOne(query);

  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  // Lösche gecachte Dateien
  const cachedFiles = await cache.find({ serviceId: service.id }).toArray();

  let deleted = 0;
  for (const file of cachedFiles) {
    try {
      if (file.storage?.key) {
        await s3.deleteObject({ Bucket: "cache", Key: file.storage.key }).promise();
        deleted++;
      }
    } catch (err) {
      console.error(`Error deleting cached file: ${file.storage?.key}`, err);
    }
  }

  await cache.deleteMany({ serviceId: service.id });

  res.json({
    success: true,
    filesDeleted: deleted,
  });
}

/**
 * POST /services/summary
 * Dashboard-Übersicht - Format für Panel AnalyticsDashboard
 * Body: { range, metric, serviceId, limit, fromDate, toDate }
 * 
 * Range determines both the stats period AND the history bucket size:
 * - 10m: Stats for last 10min, history = 4h in 10-minute buckets
 * - 1h: Stats for last 1h, history = 24h in 1-hour buckets
 * - 1d: Stats for last 24h, history = 30 days in daily buckets
 * - 7d: Stats for last 7d, history = 90 days in weekly buckets
 * - custom: Uses fromDate/toDate, auto-selects bucket size based on span
 */
async function servicesSummary(req, res) {
  const db = await connectDB();
  const servicesCol = db.collection("services");
  const cacheCol = db.collection("cache");
  const statsCol = db.collection("stats");

  const { 
    range: rangeInput = "1d", 
    serviceId, 
    metric: metricInput,
    limit: limitInput,
    fromDate: fromDateInput,
    toDate: toDateInput,
  } = req.body || {};

  // Range configuration
  const RANGE_MS = {
    "10m": 10 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };

  const limit = typeof limitInput === "number" && limitInput > 0 
    ? Math.min(limitInput, 2000) 
    : 500;
  const nowTs = Date.now();

  // Determine date range
  let fromDate, toDate, rangeKey, isCustomRange = false;

  if (rangeInput === "custom" && fromDateInput && toDateInput) {
    // Custom date range
    fromDate = new Date(fromDateInput);
    toDate = new Date(toDateInput);
    rangeKey = "custom";
    isCustomRange = true;
    
    // Validate dates
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid fromDate or toDate" });
    }
    if (fromDate >= toDate) {
      return res.status(400).json({ error: "fromDate must be before toDate" });
    }
  } else {
    // Preset range
    rangeKey = RANGE_MS[rangeInput] ? rangeInput : "1d";
    const rangeMs = RANGE_MS[rangeKey];
    toDate = new Date(nowTs);
    fromDate = new Date(nowTs - rangeMs);
  }

  const allServices = await servicesCol.find({ active: true }).toArray();

  if (!allServices.length) {
    return res.json({
      range: rangeKey,
      from: null,
      to: null,
      totalServices: 0,
      totalFiles: 0,
      totalBytes: 0,
      totalRequests: 0,
      totalTrafficBytes: 0,
      services: [],
      topFiles: [],
      history: { metric: "traffic", availableMetrics: ["traffic", "requests"], days: [] },
    });
  }

  const serviceNames = allServices.map((s) => s.name);
  const serviceNameToId = new Map(allServices.map((s) => [s.name, s.id]));
  const serviceIdToName = new Map(allServices.map((s) => [s.id, s.name]));

  // Build stats match filter - Stats are stored by serviceName!
  const statsMatch = { 
    windowStart: { $gte: fromDate, $lte: toDate } 
  };
  if (serviceId) {
    // Find service name for this ID
    const svc = allServices.find((s) => s.id === parseInt(serviceId, 10));
    if (svc) {
      statsMatch.serviceName = svc.name;
    }
  } else {
    statsMatch.serviceName = { $in: serviceNames };
  }

  // Cache stats (file count & bytes per service)
  const cacheAgg = await cacheCol
    .aggregate([
      { $match: { serviceId: { $in: allServices.map((s) => s.id) } } },
      {
        $group: {
          _id: "$serviceId",
          totalBytes: { $sum: { $ifNull: ["$sizeBytes", 0] } },
          fileCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const cacheByServiceId = new Map(cacheAgg.map((a) => [a._id, a]));

  // Stats aggregation (requests & traffic per file)
  let statsRows = [];
  try {
    statsRows = await statsCol
      .aggregate([
        { $match: statsMatch },
        {
          $group: {
            _id: {
              serviceName: "$serviceName",
              filePath: "$filePath",
              contentType: "$contentType",
            },
            requests: { $sum: "$count" },
            trafficBytes: { $sum: "$trafficBytes" },
          },
        },
        { $sort: { trafficBytes: -1 } },
        { $limit: limit },
      ])
      .toArray();
  } catch (e) {
    console.error("servicesSummary stats agg error", e.message);
  }

  // Build per-service stats and topFiles
  const perServiceStats = new Map();
  let totalRequests = 0;
  let totalTrafficBytes = 0;

  const topFiles = statsRows.map((r) => {
    totalRequests += r.requests;
    totalTrafficBytes += r.trafficBytes;
    
    const serviceName = r._id.serviceName;
    const svc = perServiceStats.get(serviceName) || {
      requests: 0,
      trafficBytes: 0,
      files: [],
    };
    svc.requests += r.requests;
    svc.trafficBytes += r.trafficBytes;
    svc.files.push({
      filePath: r._id.filePath,
      contentType: r._id.contentType,
      requests: r.requests,
      trafficBytes: r.trafficBytes,
    });
    perServiceStats.set(serviceName, svc);
    
    return {
      serviceName,
      filePath: r._id.filePath,
      contentType: r._id.contentType,
      requests: r.requests,
      trafficBytes: r.trafficBytes,
    };
  });

  // Build services array
  let totalFiles = 0;
  let totalBytes = 0;

  const services = allServices.map((s) => {
    const cacheData = cacheByServiceId.get(s.id) || { fileCount: 0, totalBytes: 0 };
    totalFiles += cacheData.fileCount || 0;
    totalBytes += cacheData.totalBytes || 0;
    
    const stats = perServiceStats.get(s.name) || {
      requests: 0,
      trafficBytes: 0,
      files: [],
    };
    
    return {
      serviceId: s.id,
      id: s.id,
      name: s.name,
      serviceName: s.name,
      fileCount: cacheData.fileCount || 0,
      totalBytes: cacheData.totalBytes || 0,
      stats: {
        range: rangeKey,
        requests: stats.requests,
        trafficBytes: stats.trafficBytes,
        topFiles: stats.files.slice(0, 25),
      },
    };
  });

  // --- History with dynamic buckets based on range ---
  const metric = metricInput === "requests" ? "requests" : "traffic";
  const history = {
    metric,
    availableMetrics: ["traffic", "requests"],
    days: [],
  };

  // History configuration per range
  const HISTORY_CONFIG = {
    "10m": {
      lookbackMs: 4 * 60 * 60 * 1000,        // 4 hours back
      unit: "minute",
      binSize: 10,
      label: (d) => d.toISOString(),
    },
    "1h": {
      lookbackMs: 24 * 60 * 60 * 1000,       // 24 hours back
      unit: "hour",
      binSize: 1,
      label: (d) => d.toISOString(),
    },
    "1d": {
      lookbackMs: 30 * 24 * 60 * 60 * 1000,  // 30 days back
      unit: "day",
      binSize: 1,
      label: (d) => d.toISOString().slice(0, 10),
    },
    "7d": {
      lookbackMs: 90 * 24 * 60 * 60 * 1000,  // 90 days back
      unit: "week",
      binSize: 1,
      label: (d) => d.toISOString().slice(0, 10),
    },
  };

  // Auto-select bucket config for custom range based on span
  function getCustomRangeConfig(from, to) {
    const spanMs = to.getTime() - from.getTime();
    const spanHours = spanMs / (60 * 60 * 1000);
    const spanDays = spanMs / (24 * 60 * 60 * 1000);

    if (spanHours <= 4) {
      // Up to 4 hours: 10-minute buckets
      return {
        unit: "minute",
        binSize: 10,
        label: (d) => d.toISOString(),
      };
    } else if (spanHours <= 48) {
      // Up to 2 days: hourly buckets
      return {
        unit: "hour",
        binSize: 1,
        label: (d) => d.toISOString(),
      };
    } else if (spanDays <= 60) {
      // Up to 60 days: daily buckets
      return {
        unit: "day",
        binSize: 1,
        label: (d) => d.toISOString().slice(0, 10),
      };
    } else {
      // More than 60 days: weekly buckets
      return {
        unit: "week",
        binSize: 1,
        label: (d) => d.toISOString().slice(0, 10),
      };
    }
  }

  try {
    let cfg, historyStart, historyEnd;

    if (isCustomRange) {
      cfg = getCustomRangeConfig(fromDate, toDate);
      historyStart = fromDate;
      historyEnd = toDate;
    } else {
      cfg = HISTORY_CONFIG[rangeKey];
      historyEnd = new Date();
      historyStart = new Date(historyEnd.getTime() - cfg.lookbackMs);
    }

    // History match also uses serviceName
    const historyMatch = { 
      windowStart: { $gte: historyStart, $lte: historyEnd } 
    };
    if (serviceId) {
      const svc = allServices.find((s) => s.id === parseInt(serviceId, 10));
      if (svc) {
        historyMatch.serviceName = svc.name;
      }
    } else {
      historyMatch.serviceName = { $in: serviceNames };
    }

    // Use $dateTrunc for bucketing (MongoDB 5.0+)
    const buckets = await statsCol
      .aggregate([
        { $match: historyMatch },
        {
          $addFields: {
            bucket: {
              $dateTrunc: {
                date: "$windowStart",
                unit: cfg.unit,
                binSize: cfg.binSize,
                timezone: "UTC",
              },
            },
          },
        },
        {
          $group: {
            _id: "$bucket",
            requests: { $sum: "$count" },
            trafficBytes: { $sum: "$trafficBytes" },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const bucketMap = new Map(buckets.map((b) => [b._id.getTime(), b]));

    // Calculate bucket span in ms
    const bucketSpanMs = (() => {
      if (cfg.unit === "minute") return cfg.binSize * 60 * 1000;
      if (cfg.unit === "hour") return cfg.binSize * 60 * 60 * 1000;
      if (cfg.unit === "day") return cfg.binSize * 24 * 60 * 60 * 1000;
      if (cfg.unit === "week") return cfg.binSize * 7 * 24 * 60 * 60 * 1000;
      return 24 * 60 * 60 * 1000;
    })();

    // Floor timestamp to bucket start
    function floorToBucket(ts) {
      if (cfg.unit === "minute") {
        const size = cfg.binSize * 60 * 1000;
        return Math.floor(ts / size) * size;
      }
      if (cfg.unit === "hour") {
        const size = cfg.binSize * 60 * 60 * 1000;
        return Math.floor(ts / size) * size;
      }
      if (cfg.unit === "day") {
        const d = new Date(ts);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      }
      if (cfg.unit === "week") {
        const d = new Date(ts);
        const utcDay = d.getUTCDay();
        const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        return dayStart - utcDay * 24 * 60 * 60 * 1000;
      }
      const dayMs = 24 * 60 * 60 * 1000;
      return Math.floor(ts / dayMs) * dayMs;
    }

    // Generate all buckets in range
    let cursorTs = floorToBucket(historyStart.getTime());
    const endTs = floorToBucket(historyEnd.getTime());

    while (cursorTs <= endTs) {
      const data = bucketMap.get(cursorTs) || { requests: 0, trafficBytes: 0 };
      const bucketDate = new Date(cursorTs);
      history.days.push({
        day: cfg.label(bucketDate),
        requests: data.requests || 0,
        trafficBytes: data.trafficBytes || 0,
        traffic: data.trafficBytes || 0,
        value: metric === "requests" ? data.requests || 0 : data.trafficBytes || 0,
      });
      cursorTs += bucketSpanMs;
    }
  } catch (e) {
    console.error("history aggregation error", e.message);
  }

  res.json({
    success: true,
    range: rangeKey,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    totalServices: allServices.length,
    totalFiles,
    totalBytes,
    totalRequests,
    totalTrafficBytes,
    services,
    topFiles,
    history,
  });
}

module.exports = {
  createService,
  deleteService,
  updateService,
  updateServers,
  listServices,
  getService,
  clearServiceCache,
  servicesSummary,
};
