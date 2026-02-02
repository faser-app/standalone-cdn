const connectDB = require('./connection')
const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
    endpoint: process.env.CACHE_URL,
    accessKeyId: process.env.CACHE_USERNAME,
    secretAccessKey: process.env.CACHE_PASSWORD,
    s3ForcePathStyle: true,
});

async function clearCache() {
    const db = await connectDB()
    const cache = await db.collection('cache')
    await cache.deleteMany({})

    const params = {
        Bucket: "cache"
    };


    const listedObjects = await s3.listObjectsV2(params).promise();

    if (listedObjects.Contents.length === 0) return;

    const deleteParams = {
        Bucket: "cache",
        Delete: { Objects: [] }
    };

    listedObjects.Contents.forEach(({ Key }) => {
        deleteParams.Delete.Objects.push({ Key });
    });

    await s3.deleteObjects(deleteParams).promise();

    if (listedObjects.IsTruncated) {
        params.ContinuationToken = listedObjects.NextContinuationToken;
        await clearCache();
    }
}

module.exports = clearCache;