const fs = require('fs');
const [inputFile, outputFile, countryArg] = process.argv.slice(2);

const leads   = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const country = countryArg || 'Unknown';

function normaliseDomain(raw) {
    if (!raw) return '';
    try {
        const href = raw.startsWith('http') ? raw : `http://${raw}`;
        return new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
        // malformed URL (e.g. relative path, linkedin slug) — fall back to raw string
        return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
    }
}

// 去重键与 zhimao DB 唯一约束保持一致：(name_canonical, country)。
// 旧键 (name + domain) 会导致同名同国不同域名的公司通过去重后进入同批次，
// 在 bulk API 的 ON CONFLICT(name_canonical,country) 中互相冲突（整批失败）。
// 策略：同 key 多条时，优先保留有 inference_breakdown 的（数据更丰富），
//       其次保留有 primary_email/primary_phone 的，最后 last-wins。
const seen    = new Map(); // key → lead
for (const l of leads) {
    if (!l.company_name) continue;
    const nameKey = l.company_name.toLowerCase().trim();
    const countryKey = (country || 'unknown').toUpperCase();
    const key = `${nameKey}|${countryKey}`;
    const existing = seen.get(key);
    if (!existing) {
        seen.set(key, l);
    } else {
        // 合并优先级：有 inference_breakdown > 有联系方式 > 保留已有
        const hasIb    = (x) => x.inference_breakdown && typeof x.inference_breakdown === 'object';
        const hasContact = (x) => !!(x.primary_email || x.primary_phone);
        if (hasIb(l) && !hasIb(existing)) {
            seen.set(key, l); // 新条有 L3，替换
        } else if (!hasIb(l) && hasIb(existing)) {
            // 保留已有（旧条更丰富）
        } else if (hasContact(l) && !hasContact(existing)) {
            seen.set(key, l); // 新条有联系方式，替换
        }
        // else: 同等质量，保留先出现的（first-wins in tie）
    }
}
const deduped = Array.from(seen.values()).map(l => ({ ...l, country }));

fs.writeFileSync(outputFile, JSON.stringify(deduped, null, 2));
console.log(`[step4] Done — ${deduped.length} unique leads (from ${leads.length}) → ${outputFile}`);
