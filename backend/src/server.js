'use strict';

const express = require('express');

const app  = express();
const PORT = process.env.API_PORT || 3000;

app.use(express.json());

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'trackista-backend' });
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[backend] Server running on port ${PORT}`);
  console.log(`[backend] NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`[backend] DB:       ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log(`[backend] Redis:    ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
});
