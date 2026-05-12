const fs = require('fs');
const { execSync } = require('child_process');

const TAXONOMY_PATH = 'zhimao_global_taxonomy.json';
const STATE_PATH    = 'zhimao_matrix_state_v8.json';

// Core strategic target countries for the Matrix
const TARGET_COUNTRIES = ['mx', 'ae', 'vn', 'id', 'th', 'my', 'sa', 'br', 'co', 'de', 'us', 'sg'];

function run() {
    console.log(`\n======================================================`);
    console.log(`[V8 CRON WORKER] DISPATCHING NEXT MATRIX TASK`);
    console.log(`======================================================`);

    if (!fs.existsSync(TAXONOMY_PATH)) {
        console.error('Taxonomy missing! Cannot proceed.');
        return;
    }
    const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));

    let state = {};
    if (fs.existsSync(STATE_PATH)) {
        state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }

    const pendingTasks = [];
    for (const [industryName, industryData] of Object.entries(taxonomy.industries)) {
        const targets = typeof industryData.subcategories === 'string'
            ? industryData.subcategories.split(' ').filter(Boolean)
            : (Array.isArray(industryData.subcategories) && industryData.subcategories.length > 0
                ? industryData.subcategories
                : [industryName]);

        targets.forEach(category => {
            TARGET_COUNTRIES.forEach(country => {
                const taskKey = `${category}|${country}`;
                const lastSwept = state[taskKey] ? new Date(state[taskKey].last_swept).getTime() : 0;
                pendingTasks.push({ category, country, lastSwept, taskKey });
            });
        });
    }

    // Sort by least recently swept (0 = never swept)
    pendingTasks.sort((a, b) => a.lastSwept - b.lastSwept);

    if (pendingTasks.length === 0) {
        console.log('[V8 Cron Worker] No tasks generated.');
        return;
    }

    const nextTask = pendingTasks[0];
    console.log(`>>> Selected Task: [${nextTask.category}] in [${nextTask.country}] <<<`);
    console.log(`Last swept: ${nextTask.lastSwept === 0 ? 'Never' : new Date(nextTask.lastSwept).toISOString()}`);

    try {
        execSync(`node zhimao_v8_ultimate_master.js ${nextTask.country} "${nextTask.category}"`, { stdio: 'inherit' });

        // Commit state only after successful completion
        state[nextTask.taskKey] = {
            last_swept: new Date().toISOString(),
            sweep_count: (state[nextTask.taskKey]?.sweep_count || 0) + 1,
        };
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        console.log(`\n[V8 Cron Worker] Task completed successfully.`);
    } catch (e) {
        console.error(`\n[V8 Cron Worker] Task failed: ${e.message}`);
    }
}

run();
