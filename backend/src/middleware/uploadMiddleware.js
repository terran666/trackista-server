'use strict';

const multer = require('multer');

const MAX_FILE_SIZE  = parseInt(process.env.ALERT_MAX_IMAGE_BYTES || String(10 * 1024 * 1024), 10);
const ALLOWED_MIMES  = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files:    1,
  },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('Only jpeg, png, webp images are allowed');
      err.code  = 'UNSUPPORTED_MEDIA_TYPE';
      cb(err, false);
    }
  },
});

/**
 * Error handler for multer — must be registered AFTER upload middleware.
 */
function handleUploadError(err, _req, res, next) {
  if (!err) return next();

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB`,
    });
  }
  if (err.code === 'UNSUPPORTED_MEDIA_TYPE') {
    return res.status(415).json({ success: false, error: err.message });
  }
  return res.status(400).json({ success: false, error: err.message || 'Upload error' });
}

module.exports = { upload, handleUploadError, ALLOWED_MIMES };
