const fs = require('fs');
const tp = 'C:/work/trackista.live-v2/src/pages/TestPage.jsx';
// Normalize to LF for matching, track whether original had CRLF
const raw = fs.readFileSync(tp, 'utf8');
const hasCRLF = raw.includes('\r\n');
let c = raw.replace(/\r\n/g, '\n');

// Change 1: Remove _isManualWatchable, make watchEnabled work for all types
const old1 = `  const _isManualWatchable = !_selectedSrc || _selectedSrc === 'manual';
  const watchEnabled = selectedLevel != null && _isManualWatchable && watchEnabledIds.has(String(selectedLevel.id));`;
const new1 = `  const watchEnabled = selectedLevel != null && watchEnabledIds.has(String(selectedLevel.id));`;
if (!c.includes(old1)) { console.error('FAIL: old1 not found'); process.exit(1); }
c = c.replace(old1, new1);
console.log('Change 1 OK');

// Change 2: Add sourceType to useLevelWatchPolling call
const old2 = `  const { watchState } = useLevelWatchPolling({
    levelId: selectedLevel?.id,
    enabled: watchEnabled,
    onNewEvent: handleNewWatchEvent,
  });`;
const new2 = `  const { watchState } = useLevelWatchPolling({
    levelId: selectedLevel?.id,
    sourceType: _selectedSrc,
    enabled: watchEnabled,
    onNewEvent: handleNewWatchEvent,
  });`;
if (!c.includes(old2)) { console.error('FAIL: old2 not found'); process.exit(1); }
c = c.replace(old2, new2);
console.log('Change 2 OK');

// Change 3: Remove MANUAL_ONLY_SOURCES filter, pass sourceType in batch poll
const old3 = `    const MANUAL_ONLY_SOURCES = new Set(['manual', undefined, null]);
    const isManualLevel = (id) => {
      const src = watchEntities[id]?.sourceType;
      return !src || MANUAL_ONLY_SOURCES.has(src);
    };
    const poll = async () => {
      const ids = [...watchEnabledIds].filter(id =>
        isManualLevel(id) && (watchStateFailedCountRef.current[id] ?? 0) < MAX_FAILS,
      );
      if (!ids.length) return;
      const results = await Promise.all(ids.map(id => fetchLevelWatchState(id).catch(() => null)));`;
const new3 = `    const poll = async () => {
      const ids = [...watchEnabledIds].filter(id =>
        (watchStateFailedCountRef.current[id] ?? 0) < MAX_FAILS,
      );
      if (!ids.length) return;
      const results = await Promise.all(ids.map(id => fetchLevelWatchState(id, watchEntities[id]?.sourceType).catch(() => null)));`;
if (!c.includes(old3)) { console.error('FAIL: old3 not found'); process.exit(1); }
c = c.replace(old3, new3);
console.log('Change 3 OK');

// Restore original line endings
const out = hasCRLF ? c.replace(/\n/g, '\r\n') : c;
fs.writeFileSync(tp, out, 'utf8');
console.log('All changes saved.');
console.log('Verify _isManualWatchable removed:', !c.includes('_isManualWatchable'));
console.log('Verify MANUAL_ONLY_SOURCES removed:', !c.includes('MANUAL_ONLY_SOURCES'));
console.log('Verify sourceType in useLevelWatchPolling:', c.includes('sourceType: _selectedSrc'));
console.log('Verify fetchLevelWatchState in batch with sourceType:', c.includes('fetchLevelWatchState(id, watchEntities'));

