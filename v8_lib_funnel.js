/**
 * 任务级漏斗指标：各 step 追加写入 funnel_<jobId>.json，worker finalize 时落库。
 */
const fs = require('fs');

function funnelPath(jobId) {
  return `funnel_${String(jobId || 'unknown')}.json`;
}

function appendFunnelStep(jobId, stepName, stats) {
  if (!jobId) return;
  const path = funnelPath(jobId);
  let doc = { steps: {}, updated_at: new Date().toISOString() };
  try {
    if (fs.existsSync(path)) {
      doc = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (!doc.steps || typeof doc.steps !== 'object') doc.steps = {};
    }
  } catch {
    doc = { steps: {}, updated_at: new Date().toISOString() };
  }
  doc.steps[stepName] = { ...stats, at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  try {
    fs.writeFileSync(path, JSON.stringify(doc, null, 2));
  } catch (e) {
    console.warn('[funnel] write failed:', e.message);
  }
}

function readFunnelDoc(jobId) {
  const path = funnelPath(jobId);
  try {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function deleteFunnelFile(jobId) {
  try {
    const path = funnelPath(jobId);
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } catch { /* ignore */ }
}

module.exports = { appendFunnelStep, readFunnelDoc, deleteFunnelFile, funnelPath };
