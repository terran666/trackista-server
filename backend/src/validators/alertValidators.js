'use strict';

const VALID_MARKETS    = new Set(['spot', 'futures', 'unknown']);
const VALID_SOURCES    = new Set(['screener', 'monitor', 'testpage', 'manual']);
// Aliases that are normalised before validation (sent by older frontend versions)
const SOURCE_ALIASES   = { 'screenshot': 'screener', 'screenshot_editor': 'screener' };
const VALID_TIMEFRAMES = new Set([
  '1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M',
]);

/**
 * Validate fields for POST /api/posts.
 * Returns { errors: string[], parsed: object }.
 */
function validateCreatePost(body, file) {
  const errors = [];

  if (!file) errors.push('image is required');

  const symbol = (body.symbol || '').trim();
  if (!symbol)            errors.push('symbol is required');
  else if (symbol.length > 32) errors.push('symbol must be 32 chars or less');

  const timeframe = (body.timeframe || '').trim();
  if (!timeframe)                        errors.push('timeframe is required');
  else if (!VALID_TIMEFRAMES.has(timeframe)) errors.push(`timeframe must be one of: ${[...VALID_TIMEFRAMES].join(', ')}`);

  const market = (body.market || 'unknown').trim().toLowerCase();
  if (!VALID_MARKETS.has(market)) errors.push(`market must be one of: ${[...VALID_MARKETS].join(', ')}`);

  let source = (body.source || '').trim().toLowerCase();
  if (SOURCE_ALIASES[source]) source = SOURCE_ALIASES[source]; // normalise alias
  if (!source)                     errors.push('source is required');
  else if (!VALID_SOURCES.has(source)) errors.push(`source must be one of: ${[...VALID_SOURCES].join(', ')}`);

  // note is optional — empty string is stored as-is
  const note = (body.note || '').trim();
  if (note.length > 1000) errors.push('note must be 1000 chars or less');

  const exchangeName = (body.exchangeName || '').trim() || null;
  if (exchangeName && exchangeName.length > 32) errors.push('exchangeName must be 32 chars or less');

  const layoutName = (body.layoutName || '').trim() || null;
  if (layoutName && layoutName.length > 64) errors.push('layoutName must be 64 chars or less');

  let chartPrice = null;
  if (body.chartPrice !== undefined && body.chartPrice !== '') {
    chartPrice = parseFloat(body.chartPrice);
    if (isNaN(chartPrice) || chartPrice < 0) errors.push('chartPrice must be a non-negative number');
  }

  return {
    errors,
    parsed: {
      symbol:       symbol.toUpperCase(),
      timeframe,
      market,
      source,
      note,
      exchangeName,
      layoutName,
      chartPrice,
    },
  };
}

/**
 * Validate body for POST /api/posts/:id/comments.
 */
function validateComment(body) {
  const errors = [];
  const text = (body.text || '').trim();
  if (!text)             errors.push('text is required');
  else if (text.length > 500) errors.push('text must be 500 chars or less');
  return { errors, parsed: { text } };
}

/**
 * Validate body for POST /api/posts/:id/vote.
 * vote must be 'like', 'dislike', or null.
 */
function validateVote(body) {
  const errors = [];
  const raw  = body.vote;
  const vote = raw === null || raw === undefined || raw === ''
    ? null
    : String(raw).trim().toLowerCase();

  if (vote !== null && vote !== 'like' && vote !== 'dislike') {
    errors.push('vote must be "like", "dislike", or null');
  }
  return { errors, parsed: { vote } };
}

module.exports = { validateCreatePost, validateComment, validateVote };
