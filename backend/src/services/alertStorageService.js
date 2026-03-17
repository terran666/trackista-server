'use strict';

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const sharp          = require('sharp');

const ENDPOINT   = process.env.STORAGE_ENDPOINT   || 'http://minio:9000';
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY || 'minioadmin';
const SECRET_KEY = process.env.STORAGE_SECRET_KEY || 'minioadmin';
const BUCKET     = process.env.STORAGE_BUCKET     || 'trackista-alerts';
const REGION     = process.env.STORAGE_REGION     || 'us-east-1';
// Public base URL used inside stored image_url.
// In production set STORAGE_PUBLIC_URL to your CDN or external MinIO URL.
const PUBLIC_URL = (process.env.STORAGE_PUBLIC_URL || 'http://localhost:9000').replace(/\/$/, '');

const s3 = new S3Client({
  endpoint:      ENDPOINT,
  region:        REGION,
  credentials:   { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true, // required for MinIO path-style URLs
});

/**
 * Ensure the storage bucket exists and has a public-read policy.
 * Called once at backend startup.
 */
async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`[storage] Bucket "${BUCKET}" ready`);
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (status === 404 || err.name === 'NotFound' || err.name === 'NoSuchBucket') {
      console.log(`[storage] Creating bucket "${BUCKET}"...`);
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect:    'Allow',
          Principal: '*',
          Action:    ['s3:GetObject'],
          Resource:  [`arn:aws:s3:::${BUCKET}/*`],
        }],
      });
      await s3.send(new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: policy }));
      console.log(`[storage] Bucket "${BUCKET}" created with public-read policy`);
    } else {
      console.warn(`[storage] Could not verify bucket (will retry on next upload): ${err.message}`);
    }
  }
}

/**
 * Validate and optionally resize an image using sharp.
 * Sharp reads the actual pixel data — catches invalid/corrupted files
 * regardless of what the Content-Type header claims.
 *
 * Returns { buffer, width, height, format }.
 */
async function processImage(rawBuffer) {
  let meta;
  try {
    meta = await sharp(rawBuffer).metadata();
  } catch (_) {
    throw Object.assign(new Error('Invalid or corrupted image'), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  }

  const allowed = new Set(['jpeg', 'png', 'webp']);
  if (!allowed.has(meta.format)) {
    throw Object.assign(
      new Error(`Unsupported image format "${meta.format}". Use jpeg, png, or webp.`),
      { code: 'UNSUPPORTED_MEDIA_TYPE' },
    );
  }

  // Downscale if wider/taller than 4096 px (keeps aspect ratio)
  const MAX_DIM = 4096;
  const needsResize = (meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM;

  const { data, info } = needsResize
    ? await sharp(rawBuffer)
        .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true })
    : await sharp(rawBuffer).toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height, format: meta.format };
}

/**
 * Upload an alert screenshot to object storage.
 *
 * @param {Buffer} rawBuffer  Raw file buffer from multer memory storage
 * @param {number} userId     Author user id (used in storage path)
 * @returns {Promise<{ url: string, key: string, width: number, height: number }>}
 */
async function uploadAlertImage(rawBuffer, userId) {
  const { buffer, width, height, format } = await processImage(rawBuffer);

  const ext         = format === 'jpeg' ? 'jpg' : format;
  const now         = new Date();
  const yyyy        = now.getUTCFullYear();
  const mm          = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key         = `alerts/${userId}/${yyyy}/${mm}/${uuidv4()}.${ext}`;
  const contentType = format === 'jpeg' ? 'image/jpeg'
    : format === 'png'  ? 'image/png'
    : 'image/webp';

  await s3.send(new PutObjectCommand({
    Bucket:       BUCKET,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  const url = `${PUBLIC_URL}/${BUCKET}/${key}`;
  console.log(`[storage] Uploaded ${key} (${width}×${height} ${format})`);
  return { url, key, width, height };
}

/**
 * Delete an object from storage. Best-effort — errors are logged, not thrown.
 *
 * @param {string} key  Storage key returned by uploadAlertImage
 */
async function deleteAlertImage(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log(`[storage] Deleted ${key}`);
  } catch (err) {
    console.error(`[storage] Failed to delete ${key}: ${err.message}`);
  }
}

module.exports = { ensureBucket, uploadAlertImage, deleteAlertImage };
