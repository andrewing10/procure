const { execSync } = require('child_process');

console.log("Starting V8 Continuous Full Volume Scraping Loop...");

const IDLE_DELAY_MS  = parseInt(process.env.IDLE_DELAY_MS  || '10000', 10);
const ERROR_DELAY_MS = parseInt(process.env.ERROR_DELAY_MS || '30000', 10);

function sleep(ms) {
    execSync(`node -e "setTimeout(()=>{}, ${ms})"`);
}

function runLoop() {
    while (true) {
        try {
            console.log("\n=============================================");
            console.log(`[V8 Loop] Triggering sweep at ${new Date().toISOString()}`);
            console.log("=============================================");
            execSync('node v8_cron_worker.js', { stdio: 'inherit' });
            console.log(`[V8 Loop] Worker finished. Sleeping ${IDLE_DELAY_MS}ms before next sweep...`);
            sleep(IDLE_DELAY_MS);
        } catch (error) {
            console.error(`[V8 Loop] Worker error. Pausing ${ERROR_DELAY_MS}ms before retry...`);
            sleep(ERROR_DELAY_MS);
        }
    }
}

runLoop();
