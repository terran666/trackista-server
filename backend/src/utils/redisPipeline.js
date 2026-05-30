'use strict';
/**
 * redisPipeline.js — small helpers for ioredis pipeline result checks.
 *
 * `pipeline.exec()` returns an array of `[err, res]` tuples — or `null` if the
 * connection was lost mid-flight. Callers historically just `await pipeline.exec()`
 * and silently lose data on partial failures. These helpers surface those errors
 * without throwing (so background loops keep ticking) while still logging the
 * first offending command.
 */

/**
 * Inspect an ioredis pipeline `exec()` result. Logs a single line per failed
 * command (capped at 3 to avoid log floods) and returns `true` if any command
 * failed or if `results` is null/undefined.
 *
 * @param {Array<[Error|null, unknown]>|null|undefined} results
 * @param {string} tag                Log prefix, e.g. '[alertEngine]'
 * @returns {boolean}                  true if there were failures
 */
function checkPipelineResult(results, tag) {
  if (!results) {
    console.error(`${tag} pipeline.exec returned no results (connection lost?)`);
    return true;
  }
  let failed = 0;
  for (const entry of results) {
    if (!entry) continue;
    const err = entry[0];
    if (err) {
      if (failed < 3) console.error(`${tag} pipeline cmd error:`, err.message || err);
      failed++;
    }
  }
  if (failed > 3) console.error(`${tag} pipeline had ${failed} failed commands total`);
  return failed > 0 || !results;
}

/**
 * Convenience: run pipeline.exec() and check the result in one line.
 * Returns the raw results array (or null on connection loss).
 */
async function execAndCheck(pipeline, tag) {
  const results = await pipeline.exec();
  checkPipelineResult(results, tag);
  return results;
}

module.exports = { checkPipelineResult, execAndCheck };
