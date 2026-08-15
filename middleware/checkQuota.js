// Middleware to ensure user has scans left
function checkScanQuota(req, res, next) {
  if (req.user && req.user.maxScans > 0) {
    return next();
  }

  // Return an HTMX-friendly quota error fragment (HTTP 200 so HTMX renders it)
  return res.status(200).send(`
    <div style="border: 1px solid #ef4444; background: #fef2f2; padding: 15px; border-radius: 8px; color: #991b1b; text-align: center;">
      <h4 style="margin: 0 0 5px 0;">⚠️ Scan Quota Exceeded</h4>
      <p style="margin: 0; font-size: 14px;">
        You have <strong>0 scans remaining</strong> on your current <code>${req.user.subPlan}</code> plan.
      </p>
    </div>
  `);
}

module.exports = checkScanQuota;
