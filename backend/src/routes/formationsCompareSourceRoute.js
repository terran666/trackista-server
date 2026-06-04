'use strict';

const { buildFormationSourceAudit } = require('../formations/sourceAudit');

function createFormationsCompareSourceHandler({ service }) {
  return async function formationsCompareSourceHandler(req, res) {
    try {
      const symbol = String(req.query.symbol || '').toUpperCase().trim();
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol query param is required' });
      }

      const tf = req.query.tf ? String(req.query.tf).trim() : null;
      const marketType = req.query.marketType ? String(req.query.marketType).trim() : 'futures';

      const audit = await buildFormationSourceAudit(service, { symbol, tf, marketType });
      return res.json({
        success: true,
        symbol: audit.symbol,
        tf: audit.tf,
        marketType: audit.marketType,
        currentPrice: audit.currentPrice,
        counts: audit.counts,
        visibleSupports: audit.visibleSupports,
        visibleResistances: audit.visibleResistances,
        extremeClusters: audit.extremeClusters,
        mismatches: audit.mismatches,
        quality: audit.quality,
        decisionTrace: audit.decisionTrace,
        generatedAt: audit.generatedAt,
      });
    } catch (err) {
      console.error('[formations] compare-source error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createFormationsCompareSourceHandler };
