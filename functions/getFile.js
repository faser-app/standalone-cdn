const connectDB = require("./connection");
const AWS = require("aws-sdk");
require("dotenv").config();
const axios = require("axios");
const sharp = require("sharp");
const http = require("http");
const https = require("https");
const { recordStat } = require("./statsBuffer");

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
});

const axiosClient = axios.create({
  timeout: 10000,
  maxRedirects: 3,
  httpAgent: keepAliveHttpAgent,
  httpsAgent: keepAliveHttpsAgent,
  validateStatus: (status) => status >= 200 && status < 400,
});

const s3 = new AWS.S3({
  endpoint: process.env.CACHE_URL,
  accessKeyId: process.env.CACHE_USERNAME,
  secretAccessKey: process.env.CACHE_PASSWORD,
  s3ForcePathStyle: true,
  httpOptions: {
    timeout: 10000,
    connectTimeout: 3000,
    agent: keepAliveHttpsAgent,
  },
});

function inferContentTypeFromFormat(format, fallback) {
  if (!format) return fallback || "application/octet-stream";
  const map = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    tiff: "image/tiff",
    gif: "image/gif",
    svg: "image/svg+xml",
    heif: "image/heif",
    // Video formats
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    ogv: "video/ogg",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv",
    flv: "video/x-flv",
    mkv: "video/x-matroska",
    m4v: "video/x-m4v",
    // Audio formats
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    flac: "audio/flac",
    aac: "audio/aac",
  };
  return map[format] || fallback || "application/octet-stream";
}

function setImageHeaders(
  res,
  {
    width,
    height,
    contentType,
    lengthBytes,
    dpr,
    originalWidth,
    originalHeight,
    downsampled,
    scaleToOriginal,
  }
) {
  if (contentType) res.setHeader("Content-Type", contentType);
  if (typeof width === "number") res.setHeader("X-Image-Width", String(width));
  if (typeof height === "number")
    res.setHeader("X-Image-Height", String(height));
  if (typeof originalWidth === "number")
    res.setHeader("X-Image-Original-Width", String(originalWidth));
  if (typeof originalHeight === "number")
    res.setHeader("X-Image-Original-Height", String(originalHeight));
  if (typeof downsampled === "boolean")
    res.setHeader("X-Image-Downsampled", String(downsampled));
  if (
    typeof scaleToOriginal === "number" &&
    isFinite(scaleToOriginal) &&
    scaleToOriginal > 0
  ) {
    res.setHeader("X-Image-Scale-To-Original", String(scaleToOriginal));
  }
  if (typeof dpr === "number" && isFinite(dpr) && dpr > 0) {
    res.setHeader("Content-DPR", String(dpr));
  }
  if (typeof lengthBytes === "number")
    res.setHeader("Content-Length", String(lengthBytes));
}

// Extrahiert den Dateinamen aus einem Content-Disposition Header
function parseFileNameFromContentDisposition(header) {
  if (!header) return null;

  // Versuche filename*=UTF-8'' Format (RFC 5987)
  const utf8Match = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (e) {
      // Fallback
    }
  }

  // Versuche filename="..." Format
  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  // Versuche filename=... Format (ohne Anführungszeichen)
  const unquotedMatch = header.match(/filename=([^;\s]+)/i);
  if (unquotedMatch) {
    return unquotedMatch[1];
  }

  return null;
}

async function getFile(req, res) {
  const db = await connectDB();

  const servicesCollection = await db.collection("services");
  const cache = await db.collection("cache");

  // Stats tracking
  let statsData = null;

  const recordStatsOnComplete = (
    serviceName,
    filePath,
    contentType,
    bytes,
    isRangeRequest = false,
    rangeStart = null,
    rangeEnd = null
  ) => {
    statsData = {
      serviceName,
      filePath,
      contentType,
      bytes,
      isRangeRequest,
      rangeStart,
      rangeEnd,
    };
  };

  res.on("finish", () => {
    if (statsData && res.statusCode >= 200 && res.statusCode < 300) {
      const logMsg = statsData.isRangeRequest
        ? `[STATS] finish: ${statsData.serviceName}/${statsData.filePath}, status: ${res.statusCode}, range: ${statsData.rangeStart}-${statsData.rangeEnd}, bytes: ${statsData.bytes}`
        : `[STATS] finish: ${statsData.serviceName}/${statsData.filePath}, status: ${res.statusCode}, bytes: ${statsData.bytes}`;
      console.log(logMsg);

      try {
        recordStat(
          statsData.serviceName,
          statsData.filePath,
          statsData.contentType,
          statsData.bytes,
          statsData.isRangeRequest
        );
      } catch (e) {
        if (process.env.DEBUG === "1")
          console.error("Stats recording error:", e);
      }
    }
  });

  res.on("close", () => {
    if (statsData && !res.finished) {
      if (process.env.DEBUG === "1") {
        console.log(
          `Connection closed prematurely for ${statsData.serviceName}/${statsData.filePath} - stats not recorded`
        );
      }
    }
  });

  const serviceName = (req.params.service || "")
    .toLowerCase()
    .replace(/\/+$/, "");
  const nameParam = req.params.name;
  let rawPath = Array.isArray(nameParam)
    ? nameParam.join("/")
    : nameParam || "";
  rawPath = rawPath.replace(/^\/+/, "");
  rawPath = rawPath.replace(/\/+$/, "");
  const filePathOnly = rawPath.replace(/\/+/g, "/");

  const cdnParams = [
    "size",
    "scale",
    "max",
    "download",
    "imgformat",
    "imgtype",
  ];
  const queryParams = {};

  for (const [key, value] of Object.entries(req.query)) {
    if (!cdnParams.includes(key)) {
      queryParams[key] = value;
    }
  }

  const searchParams = new URLSearchParams(queryParams).toString();
  let baseKey = `${serviceName}/${filePathOnly}`;
  baseKey = baseKey.replace(/\/+/g, "/").replace(/\/+$/, "");
  const cacheKey = searchParams ? `${baseKey}?${searchParams}` : baseKey;
  
  if (process.env.DEBUG === "1") {
    console.log("S3 baseKey:", baseKey);
    console.log("S3 cacheKey:", cacheKey);
  }

  const sizeParam = req.query.size;
  const scaleParam = req.query.scale;
  const maxParam = req.query.max;
  const isDownload = req.query.download === "1";
  const imgType =
    req.query.imgformat || req.query.imgtype
      ? (req.query.imgformat || req.query.imgtype).toLowerCase()
      : null;
  const isHead = req.method === "HEAD";

  let width, height;
  let scale;

  if (sizeParam) {
    if (sizeParam.includes("x")) {
      const dimensions = sizeParam.split("x");
      width = parseInt(dimensions[0], 10);
      height = parseInt(dimensions[1], 10);
    } else {
      const val = parseInt(sizeParam, 10);
      width = val;
      height = val;
    }
  }

  if (maxParam) {
    if (maxParam.includes("x")) {
      const dimensions = maxParam.split("x");
      width = parseInt(dimensions[0], 10);
      height = parseInt(dimensions[1], 10);
    } else if (maxParam.endsWith("w")) {
      width = parseInt(maxParam.slice(0, -1), 10);
    } else if (maxParam.endsWith("h")) {
      height = parseInt(maxParam.slice(0, -1), 10);
    } else {
      const val = parseInt(maxParam, 10);
      width = val;
      height = val;
    }
  }

  if (scaleParam) {
    scale = parseInt(scaleParam, 10);
  }

  let fileBuffer;
  let contentType;
  let cachedFileName = null;

  const existingCacheDoc = await cache.findOne({ path: cacheKey });
  if (existingCacheDoc) {
    cachedFileName = existingCacheDoc.fileName || null;
    const s3Key =
      existingCacheDoc &&
      existingCacheDoc.storage &&
      existingCacheDoc.storage.key
        ? existingCacheDoc.storage.key
        : cacheKey;
    const params = {
      Bucket: "cache",
      Key: s3Key,
    };

    try {
      const s3Response = await s3.getObject(params).promise();
      contentType = s3Response.ContentType || contentType;
      fileBuffer = s3Response.Body;

      if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        res.status(404).send("File not found");
        return;
      }

      await cache.updateOne(
        { path: cacheKey },
        {
          $set: {
            lastUsed: new Date(),
          },
        }
      );
    } catch (err) {
      res.status(404).send("File not found");
      return;
    }
  } else {
    try {
      let found = false;
      if (!serviceName) {
        res.status(400).send("Service name missing");
        return;
      }

      const service = await servicesCollection.findOne({
        name: serviceName,
        active: true,
      });
      if (!service) {
        res.status(404).send("Service not found");
        return;
      }

      const addresses = Array.isArray(service.serverAddresses)
        ? service.serverAddresses
        : [];

      if (addresses.length === 0) {
        res.status(404).send("No origin servers configured for this service");
        return;
      }

      try {
        const obj = await s3
          .getObject({ Bucket: "cache", Key: cacheKey })
          .promise();
        fileBuffer = obj.Body;
        contentType = obj.ContentType || contentType;

        const safeDoc = {
          path: String(cacheKey),
          insertDate: new Date(),
          lastUsed: new Date(),
          sizeBytes: Number(fileBuffer.length) || 0,
          serviceId:
            typeof service?.id === "number" || typeof service?.id === "string"
              ? service.id
              : service?._id?.toString?.() ?? null,
          storage: { bucket: "cache", key: String(cacheKey) },
        };
        await cache.insertOne(safeDoc);

        found = true;
      } catch (_) {}

      let successfulResult = null;
      if (!found && addresses.length > 0) {
        const reqs = addresses.map((addr) => {
          return new Promise((resolve, reject) => {
            const trimmed = (addr || "").replace(/\/+$/, "");
            let url = `${trimmed}/${filePathOnly}`;

            console.log(url);

            if (Object.keys(queryParams).length > 0) {
              const urlObj = new URL(url);
              for (const [key, value] of Object.entries(queryParams)) {
                urlObj.searchParams.append(key, value);
              }
              url = urlObj.toString();
            }

            const client = url.startsWith("https://") ? https : http;

            client
              .get(url, (response) => {
                if (response.statusCode !== 200) {
                  return reject(new Error(`HTTP ${response.statusCode}`));
                }

                const chunks = [];
                let downloaded = 0;
                const totalLength = parseInt(
                  response.headers["content-length"],
                  10
                );

                response.on("data", (chunk) => {
                  chunks.push(chunk);
                  downloaded += chunk.length;

                  if (totalLength) {
                    const percent = ((downloaded / totalLength) * 100).toFixed(
                      2
                    );
                    process.stdout.write(
                      `${(downloaded / (1024 * 1024)).toFixed(2)} MB / ${(
                        totalLength /
                        (1024 * 1024)
                      ).toFixed(2)} MB (${percent}%)\r`
                    );
                  } else {
                    process.stdout.write(
                      `${(downloaded / (1024 * 1024)).toFixed(2)} MB loaded\r`
                    );
                  }
                });

                response.on("end", () => {
                  const buffer = Buffer.concat(chunks);
                  console.log(
                    `Download finished (${(downloaded / (1024 * 1024)).toFixed(
                      2
                    )} MB)`
                  );

                  const httpFileName = parseFileNameFromContentDisposition(
                    response.headers["content-disposition"]
                  );

                  resolve({
                    response: {
                      data: buffer,
                      headers: response.headers,
                      fileName: httpFileName,
                    },
                    origin: addr,
                  });
                });

                response.on("error", reject);
              })
              .on("error", reject);
          });
        });

        try {
          successfulResult = await Promise.any(reqs);
        } catch (err) {
          console.error("Error while downloading:", err);
          successfulResult = null;
        }
      }

      if (successfulResult) {
        const { response } = successfulResult;
        fileBuffer = Buffer.from(response.data);
        contentType = response.headers["content-type"];

        const originFileName = response.fileName || null;

        if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
          res.status(404).send("File not found");
          return;
        }

        const safeDoc2 = {
          path: String(cacheKey),
          insertDate: new Date(),
          lastUsed: new Date(),
          sizeBytes: Number(fileBuffer.length) || 0,
          serviceId:
            typeof service?.id === "number" || typeof service?.id === "string"
              ? service.id
              : service?._id?.toString?.() ?? null,
          storage: { bucket: "cache", key: String(cacheKey) },
          fileName: originFileName || null,
        };
        await cache.insertOne(safeDoc2);

        const params = {
          Bucket: "cache",
          Key: cacheKey,
          Body: fileBuffer,
          ContentType: contentType,
        };

        await s3.upload(params).promise();
        found = true;
      }

      if (!found) {
        res.status(404).send("File not found");
        return;
      }
    } catch (err) {
      res.status(404).send("File not found");
      return;
    }
  }

  let fileName =
    cachedFileName ||
    (req.query.file ? decodeURIComponent(req.query.file) : null);

  if (!fileName) {
    const pathParts = filePathOnly.split("/");
    const lastPart = pathParts[pathParts.length - 1];

    if (lastPart && lastPart.includes(".")) {
      fileName = lastPart;
    } else {
      const extFromContentType = contentType
        ? contentType.split("/")[1]?.split("+")[0]
        : null;
      fileName = `file${extFromContentType ? `.${extFromContentType}` : ""}`;
    }
  }

  // Verbessere Content-Type basierend auf Dateiendung
  if (!contentType || contentType === "application/octet-stream") {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext) {
      const detectedType = inferContentTypeFromFormat(ext, contentType);
      if (detectedType !== "application/octet-stream") {
        contentType = detectedType;
      }
    }
  }

  const encoded = encodeURIComponent(fileName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  if (isDownload) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`
    );
  } else {
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileName}"; filename*=UTF-8''${encoded}`
    );
  }

  const isImage = contentType && contentType.startsWith("image/");
  const isVideo =
    contentType &&
    (contentType.startsWith("video/") || contentType.startsWith("audio/"));
  let originalMeta = null;

  if (isImage) {
    try {
      originalMeta = await sharp(fileBuffer).metadata();
    } catch {
      originalMeta = null;
    }
  }

  const computeDownsampleInfo = (outMeta) => {
    if (!originalMeta || !outMeta) return {};
    const ow = originalMeta.width;
    const oh = originalMeta.height;
    const w = outMeta.width;
    const h = outMeta.height;

    if (
      typeof ow !== "number" ||
      typeof oh !== "number" ||
      typeof w !== "number" ||
      typeof h !== "number"
    ) {
      return { originalWidth: ow, originalHeight: oh };
    }

    const downsampled = w < ow || h < oh;
    const scaleToOriginal = Math.max(ow / Math.max(w, 1), oh / Math.max(h, 1));
    return {
      originalWidth: ow,
      originalHeight: oh,
      downsampled,
      scaleToOriginal,
    };
  };

  const handleRangeRequest = (buffer, contentType) => {
    const range = req.headers.range;

    if (!range) {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType || "video/mp4");
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

      console.log(
        `[RANGE] ${serviceName}/${filePathOnly}: full file request (no range), size=${buffer.length}`
      );

      recordStatsOnComplete(
        serviceName,
        filePathOnly,
        contentType,
        buffer.length,
        false,
        0,
        buffer.length - 1
      );

      if (isHead) {
        res.status(200).end();
      } else {
        res.send(buffer);
      }
      return true;
    }

    // Parse Range Header
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : buffer.length - 1;

    end = Math.min(end, buffer.length - 1);

    if (start >= buffer.length || start > end || start < 0) {
      res.status(416).setHeader("Content-Range", `bytes */${buffer.length}`);
      res.send("Range Not Satisfiable");
      return true;
    }

    const chunkSize = end - start + 1;
    const chunk = buffer.slice(start, end + 1);

    console.log(
      `[RANGE] ${serviceName}/${filePathOnly}: bytes ${start}-${end}/${buffer.length}, ` +
        `chunkSize=${chunkSize}, clientRange=${range}`
    );

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${buffer.length}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(chunkSize));
    res.setHeader("Content-Type", contentType || "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    recordStatsOnComplete(
      serviceName,
      filePathOnly,
      contentType,
      chunkSize,
      true,
      start,
      end
    );

    if (isHead) {
      res.end();
    } else {
      res.send(chunk);
    }
    return true;
  };

  const finishWithBuffer = async (buffer, overrideContentType) => {
    let finalContentType =
      overrideContentType || contentType || "application/octet-stream";

    if (overrideContentType?.startsWith("image/") || isImage) {
      try {
        const outMeta = await sharp(buffer).metadata();
        finalContentType = inferContentTypeFromFormat(
          outMeta.format,
          finalContentType
        );
        const info = computeDownsampleInfo(outMeta);

        setImageHeaders(res, {
          width: outMeta.width,
          height: outMeta.height,
          contentType: finalContentType,
          lengthBytes: buffer.length,
          ...info,
        });
      } catch {
        res.setHeader("Content-Length", String(buffer.length));
        if (overrideContentType)
          res.setHeader("Content-Type", overrideContentType);
        if (originalMeta) {
          setImageHeaders(res, {
            originalWidth: originalMeta.width,
            originalHeight: originalMeta.height,
          });
        }
      }
    } else {
      res.setHeader("Content-Length", String(buffer.length));
      if (overrideContentType)
        res.setHeader("Content-Type", overrideContentType);
    }

    if (isDownload) {
      res.setHeader("Cache-Control", "no-store");
    } else if (finalContentType.startsWith("image/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }

    recordStatsOnComplete(
      serviceName,
      filePathOnly,
      finalContentType,
      buffer.length,
      false
    );

    if (isHead) {
      res.status(200).end();
    } else {
      res.send(buffer);
    }
  };

  // Image resize with size param
  if (sizeParam && isImage) {
    try {
      const originalWidth = originalMeta?.width;
      const originalHeight = originalMeta?.height;

      let targetW = Number.isFinite(width) ? width : originalWidth;
      let targetH = Number.isFinite(height) ? height : originalHeight;

      if (
        typeof originalWidth === "number" &&
        typeof originalHeight === "number"
      ) {
        if (targetW > originalWidth) targetW = originalWidth;
        if (targetH > originalHeight) targetH = originalHeight;
      }

      targetW = Math.max(1, Math.round(targetW || 1));
      targetH = Math.max(1, Math.round(targetH || 1));

      let sharpInstance = sharp(fileBuffer).resize(targetW, targetH, {
        fit: "cover",
        position: "center",
      });

      if (imgType) {
        if (imgType === "jpg" || imgType === "jpeg") {
          sharpInstance = sharpInstance
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg();
        } else {
          sharpInstance = sharpInstance.toFormat(imgType);
        }
      }

      const { data: resizedImageBuffer, info: outMeta } =
        await sharpInstance.toBuffer({ resolveWithObject: true });

      const outType = imgType
        ? inferContentTypeFromFormat(imgType, contentType)
        : inferContentTypeFromFormat(outMeta.format, contentType);
      const info = computeDownsampleInfo(outMeta);

      setImageHeaders(res, {
        width: outMeta.width,
        height: outMeta.height,
        contentType: outType,
        lengthBytes: resizedImageBuffer.length,
        ...info,
      });

      recordStatsOnComplete(
        serviceName,
        filePathOnly,
        outType,
        resizedImageBuffer.length,
        false
      );

      if (isHead) {
        res.status(200).end();
      } else {
        res.send(resizedImageBuffer);
      }
      return;
    } catch (err) {
      await finishWithBuffer(fileBuffer);
      return;
    }
  }

  // Image resize with max param
  if (maxParam && isImage) {
    try {
      const originalWidth = originalMeta?.width;
      const originalHeight = originalMeta?.height;

      let newWidth = originalWidth;
      let newHeight = originalHeight;

      if (
        typeof originalWidth === "number" &&
        typeof originalHeight === "number"
      ) {
        if (maxParam.endsWith("w")) {
          const maxWidth = parseInt(maxParam.slice(0, -1), 10);
          newWidth = Math.min(maxWidth, originalWidth);
          newHeight = Math.round((newWidth / originalWidth) * originalHeight);
        } else if (maxParam.endsWith("h")) {
          const maxHeight = parseInt(maxParam.slice(0, -1), 10);
          newHeight = Math.min(maxHeight, originalHeight);
          newWidth = Math.round((newHeight / originalHeight) * originalWidth);
        } else {
          const maxSize = parseInt(maxParam, 10);
          if (originalWidth >= originalHeight) {
            newWidth = Math.min(maxSize, originalWidth);
            newHeight = Math.round((newWidth / originalWidth) * originalHeight);
          } else {
            newHeight = Math.min(maxSize, originalHeight);
            newWidth = Math.round((newHeight / originalHeight) * originalWidth);
          }
        }
      }

      newWidth = Math.max(1, Math.round(newWidth || 1));
      newHeight = Math.max(1, Math.round(newHeight || 1));

      let sharpInstance = sharp(fileBuffer).resize(newWidth, newHeight, {
        fit: "inside",
        withoutEnlargement: true,
      });

      if (imgType) {
        if (imgType === "jpg" || imgType === "jpeg") {
          sharpInstance = sharpInstance
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg();
        } else {
          sharpInstance = sharpInstance.toFormat(imgType);
        }
      }

      const { data: resizedImageBuffer, info: outMeta } =
        await sharpInstance.toBuffer({ resolveWithObject: true });

      const outType = imgType
        ? inferContentTypeFromFormat(imgType, contentType)
        : inferContentTypeFromFormat(outMeta.format, contentType);
      const info = computeDownsampleInfo(outMeta);

      setImageHeaders(res, {
        width: outMeta.width,
        height: outMeta.height,
        contentType: outType,
        lengthBytes: resizedImageBuffer.length,
        ...info,
      });

      recordStatsOnComplete(
        serviceName,
        filePathOnly,
        outType,
        resizedImageBuffer.length,
        false
      );

      if (isHead) {
        res.status(200).end();
      } else {
        res.send(resizedImageBuffer);
      }
      return;
    } catch (error) {
      await finishWithBuffer(fileBuffer);
      return;
    }
  }

  // Image scale
  if (scale && isImage) {
    try {
      const ow = originalMeta?.width || 1;
      const oh = originalMeta?.height || 1;

      const factor = Math.max(1, Math.round(scale)) / 100;
      let newW = Math.max(1, Math.round(ow * factor));
      let newH = Math.max(1, Math.round(oh * factor));

      let sharpInstance = sharp(fileBuffer).resize(newW, newH, {
        fit: "inside",
        position: "center",
      });

      if (imgType) {
        if (imgType === "jpg" || imgType === "jpeg") {
          sharpInstance = sharpInstance
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg();
        } else {
          sharpInstance = sharpInstance.toFormat(imgType);
        }
      }

      const { data: scaledImageBuffer, info: outMeta } =
        await sharpInstance.toBuffer({ resolveWithObject: true });

      const outType = imgType
        ? inferContentTypeFromFormat(imgType, contentType)
        : inferContentTypeFromFormat(outMeta.format, contentType);
      const info = computeDownsampleInfo(outMeta);

      setImageHeaders(res, {
        width: outMeta.width,
        height: outMeta.height,
        contentType: outType,
        lengthBytes: scaledImageBuffer.length,
        dpr: factor,
        ...info,
      });

      recordStatsOnComplete(
        serviceName,
        filePathOnly,
        outType,
        scaledImageBuffer.length,
        false
      );

      if (isHead) {
        res.status(200).end();
      } else {
        res.send(scaledImageBuffer);
      }
      return;
    } catch (err) {
      await finishWithBuffer(fileBuffer);
      return;
    }
  }

  // Image format conversion only
  try {
    if (isImage) {
      if (imgType) {
        let sharpConvert = sharp(fileBuffer);

        if (imgType === "jpg" || imgType === "jpeg") {
          sharpConvert = sharpConvert
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg();
        } else {
          sharpConvert = sharpConvert.toFormat(imgType);
        }

        const { data: convertedBuffer, info: outMeta } =
          await sharpConvert.toBuffer({ resolveWithObject: true });

        const outType = inferContentTypeFromFormat(imgType, contentType);
        const info = computeDownsampleInfo(outMeta);

        setImageHeaders(res, {
          width: outMeta.width,
          height: outMeta.height,
          contentType: outType,
          lengthBytes: convertedBuffer.length,
          ...info,
          downsampled: false,
          scaleToOriginal: 1,
        });

        recordStatsOnComplete(
          serviceName,
          filePathOnly,
          outType,
          convertedBuffer.length,
          false
        );

        if (isDownload) {
          res.setHeader("Cache-Control", "no-store");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }

        if (isHead) {
          res.status(200).end();
        } else {
          res.send(convertedBuffer);
        }
        return;
      }

      const meta = originalMeta || (await sharp(fileBuffer).metadata());
      const outType = inferContentTypeFromFormat(meta.format, contentType);
      const info = computeDownsampleInfo(meta);

      setImageHeaders(res, {
        width: meta.width,
        height: meta.height,
        contentType: outType,
        lengthBytes: fileBuffer.length,
        ...info,
        downsampled: false,
        scaleToOriginal: 1,
      });
    } else {
      res.setHeader("Content-Length", String(fileBuffer.length));
    }
  } catch {
    res.setHeader("Content-Length", String(fileBuffer.length));
  }

  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    res.status(404).send("File not found");
    return;
  }

  // Video/Audio streaming with range requests
  if (isVideo && !isDownload) {
    if (handleRangeRequest(fileBuffer, contentType)) {
      return;
    }
  }

  // Stats for non-video or download requests
  if (!isVideo || isDownload) {
    recordStatsOnComplete(
      serviceName,
      filePathOnly,
      contentType,
      fileBuffer.length,
      false
    );
  }

  if (isDownload) {
    res.setHeader("Cache-Control", "no-store");
  } else if (isImage) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "public, max-age=3600");
  }

  if (isHead) {
    res.status(200).end();
  } else {
    res.send(fileBuffer);
  }
}

module.exports = getFile;
