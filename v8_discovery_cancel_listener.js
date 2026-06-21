/**
 * P1-D：discovery_cancel NOTIFY 监听 + DB 轮询兜底。
 * DATABASE_URL 可用时 LISTEN；否则仅靠 isCancelled() 轮询 PostgREST。
 */
require('./load-env');

class DiscoveryCancelListener {
  constructor() {
    /** @type {Set<string>} */
    this.cancelledIds = new Set();
    /** @type {import('pg').Client | null} */
    this.pgClient = null;
    /** @type {import('@supabase/supabase-js').SupabaseClient | null} */
    this.supabase = null;
    this.listenActive = false;
  }

  /**
   * @param {import('@supabase/supabase-js').SupabaseClient} supabase
   */
  async start(supabase) {
    this.supabase = supabase;
    const dbUrl = process.env.DATABASE_URL || '';
    if (!dbUrl) {
      console.log('[cancel-listener] DATABASE_URL unset — cancel via status poll only');
      return;
    }

    try {
      const { Client } = require('pg');
      const ssl =
        dbUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require'
          ? { rejectUnauthorized: false }
          : undefined;
      this.pgClient = new Client({ connectionString: dbUrl, ssl });
      await this.pgClient.connect();
      await this.pgClient.query('LISTEN discovery_cancel');
      this.pgClient.on('notification', (msg) => {
        if (msg.channel === 'discovery_cancel' && msg.payload) {
          this.cancelledIds.add(String(msg.payload));
          console.log(`[cancel-listener] NOTIFY discovery_cancel job=${msg.payload}`);
        }
      });
      this.pgClient.on('error', (err) => {
        console.warn('[cancel-listener] pg client error:', err?.message || err);
      });
      this.listenActive = true;
      console.log('[cancel-listener] LISTEN discovery_cancel active');
    } catch (e) {
      console.warn('[cancel-listener] pg LISTEN failed, poll-only fallback:', e?.message || e);
      this.pgClient = null;
    }
  }

  /** @param {string} jobId */
  mark(jobId) {
    this.cancelledIds.add(String(jobId));
  }

  /** @param {string} jobId */
  has(jobId) {
    return this.cancelledIds.has(String(jobId));
  }

  /**
   * @param {string} jobId
   * @returns {Promise<boolean>}
   */
  async isCancelled(jobId) {
    const id = String(jobId);
    if (this.has(id)) return true;
    if (!this.supabase) return false;
    const { data, error } = await this.supabase
      .from('discovery_jobs')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    if (error) return false;
    if (data?.status === 'cancelled') {
      this.mark(id);
      return true;
    }
    return false;
  }
}

module.exports = { DiscoveryCancelListener };
