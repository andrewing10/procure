const fs = require('fs');
const [inputFile, outputFile, , countryArg] = process.argv.slice(2);

const leads   = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const country = countryArg || 'Unknown';

const seen    = new Set();
const deduped = leads
    .filter(l => {
        if (!l.company_name) return false;
        // Dedupe key: normalised name + domain (more robust than name-only)
        const domainPart = l.domain ? new URL(l.domain.startsWith('http') ? l.domain : `http://${l.domain}`).hostname.replace(/^www\./, '') : '';
        const key = `${l.company_name.toLowerCase().trim()}|${domainPart}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    })
    .map(l => ({ ...l, country }));

fs.writeFileSync(outputFile, JSON.stringify(deduped, null, 2));
console.log(`[step4] Done — ${deduped.length} unique leads (from ${leads.length}) → ${outputFile}`);
