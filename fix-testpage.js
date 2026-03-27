const fs = require('fs');
const tp_path = 'C:/work/trackista.live-v2/src/pages/TestPage.jsx';
const mbp_path = 'C:/work/trackista.live-v2/src/pages/ManualBarBuilderPanel.jsx';
let tp = fs.readFileSync(tp_path, 'utf8').replace(/\r\n/g, '\n');
let mbp = fs.readFileSync(mbp_path, 'utf8').replace(/\r\n/g, '\n');
let ok = true;

function applyChange(name, content, oldStr, newStr) {
  if (!content.includes(oldStr)) {
    console.error('FAIL: ' + name + ' not found');
    console.error('Looking for:', JSON.stringify(oldStr.slice(0, 120)));
    ok = false;
    return content;
  }
  console.log(name + ' OK');
  return content.replace(oldStr, newStr);
}

// TestPage fix 1: remove 'sloped' from _isTrackedExtreme in handleSaveWatch
tp = applyChange('TP1', tp,
  "    const _isTrackedExtreme = _src === 'sloped' || _src === 'vertical_extreme' || _src === 'extreme';\n    const _isTrackedLevel = _src === 'auto';\n    const _id = String(selectedLevel.id);",
  "    const _isTrackedExtreme = _src === 'vertical_extreme' || _src === 'extreme';\n    const _isTrackedLevel = _src === 'auto';\n    const _id = String(selectedLevel.id);",
);

// TestPage fix 2: add sourceType to patchLevelWatch in handleSaveWatch
tp = applyChange('TP2', tp,
  '      } else {\n        await patchLevelWatch(selectedLevel.id, config);\n      }\n    } catch (err) { console.warn(\'[watch] patch failed (local watch still active)\', err.message); }\n  };\n  const handleDisableWatch = async () => {',
  '      } else {\n        await patchLevelWatch(selectedLevel.id, config, _src);\n      }\n    } catch (err) { console.warn(\'[watch] patch failed (local watch still active)\', err.message); }\n  };\n  const handleDisableWatch = async () => {',
);

// TestPage fix 3: remove 'sloped' from _isTrackedExtreme in handleDisableWatch
tp = applyChange('TP3', tp,
  "    const _isTrackedExtreme = _src === 'sloped' || _src === 'vertical_extreme' || _src === 'extreme';\n    const _isTrackedLevel = _src === 'auto';\n    // Optimistic update",
  "    const _isTrackedExtreme = _src === 'vertical_extreme' || _src === 'extreme';\n    const _isTrackedLevel = _src === 'auto';\n    // Optimistic update",
);

// TestPage fix 4: add sourceType to patchLevelWatch in handleDisableWatch
tp = applyChange('TP4', tp,
  '      } else {\n        await patchLevelWatch(selectedLevel.id, { watchEnabled: false });\n      }\n    } catch (err) { console.warn(\'[watch] disable failed (local state still updated)\', err.message); }\n  };\n  const handleDeleteSelectedLevel',
  '      } else {\n        await patchLevelWatch(selectedLevel.id, { watchEnabled: false }, _src);\n      }\n    } catch (err) { console.warn(\'[watch] disable failed (local state still updated)\', err.message); }\n  };\n  const handleDeleteSelectedLevel',
);

// ManualBarBuilderPanel fix 1: add sourceType in handleSaveWatch
mbp = applyChange('MBP1', mbp,
  '      } else {\n        await patchLevelWatch(selectedLevel.id, config);\n      }\n    } catch (err) { console.warn(\'[lab-watch] patch failed (local watch still active)\', err.message); }',
  '      } else {\n        await patchLevelWatch(selectedLevel.id, config, _src);\n      }\n    } catch (err) { console.warn(\'[lab-watch] patch failed (local watch still active)\', err.message); }',
);

// ManualBarBuilderPanel fix 2: add sourceType in handleDisableWatch
mbp = applyChange('MBP2', mbp,
  '      } else {\n        await patchLevelWatch(selectedLevel.id, { watchEnabled: false });\n      }\n    } catch (err) { console.warn(\'[lab-watch] disable failed (local state still updated)\', err.message); }',
  '      } else {\n        await patchLevelWatch(selectedLevel.id, { watchEnabled: false }, _src);\n      }\n    } catch (err) { console.warn(\'[lab-watch] disable failed (local state still updated)\', err.message); }',
);

if (!ok) { console.error('ABORTED due to failures'); process.exit(1); }

fs.writeFileSync(tp_path,  tp.replace(/\n/g, '\r\n'),  'utf8');
fs.writeFileSync(mbp_path, mbp.replace(/\n/g, '\r\n'), 'utf8');
console.log('All saved.');

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

