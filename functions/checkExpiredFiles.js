const connectDB = require("./connection");
const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
  endpoint: process.env.CACHE_URL,
  accessKeyId: process.env.CACHE_USERNAME,
  secretAccessKey: process.env.CACHE_PASSWORD,
  s3ForcePathStyle: true,
});

async function checkExpiredFiles() {
  console.log("[CLEANUP] Checking for expired files...");

  const db = await connectDB();
  const cache = db.collection("cache");
  const services = db.collection("services");

  // Lade alle aktiven Services mit ihren daysCached-Einstellungen
  const allServices = await services.find({ active: true }).toArray();
  const serviceDaysMap = new Map();

  for (const service of allServices) {
    serviceDaysMap.set(service.id, service.daysCached || 30);
  }

  // Default für unbekannte Services
  const defaultDays = 30;

  const files = await cache.find({}).toArray();
  let deletedCount = 0;

  for (const file of files) {
    const daysCached = serviceDaysMap.get(file.serviceId) || defaultDays;
    const maxAge = 1000 * 60 * 60 * 24 * daysCached;
    const age = Date.now() - new Date(file.lastUsed).getTime();

    if (age > maxAge) {
      try {
        // Lösche aus S3
        const s3Key = file.storage?.key || file.path;
        await s3.deleteObject({ Bucket: "cache", Key: s3Key }).promise();

        // Lösche aus DB
        await cache.deleteOne({ _id: file._id });

        deletedCount++;

        if (process.env.DEBUG === "1") {
          console.log(`[CLEANUP] Deleted expired file: ${s3Key}`);
        }
      } catch (err) {
        console.error(`[CLEANUP] Error deleting file: ${file.path}`, err);
      }
    }
  }

  console.log(`[CLEANUP] Deleted ${deletedCount} expired files`);
}

module.exports = checkExpiredFiles;
