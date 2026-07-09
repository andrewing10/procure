'use strict';
/**
 * Node 20 兼容的 Supabase client。
 * @supabase/realtime-js 在 Node < 22 需要显式传入 ws transport，
 * 否则 createClient 会在构造时直接抛错。
 */
const { createClient } = require('@supabase/supabase-js');

let _WsCtor = null;
function getWsTransport() {
  if (_WsCtor) return _WsCtor;
  // Node 22+ 有全局 WebSocket；仍优先用 ws，行为一致
  _WsCtor = require('ws');
  return _WsCtor;
}

/**
 * @param {string} url
 * @param {string} key
 * @param {Record<string, unknown>} [options]
 */
function createSupabaseClient(url, key, options = {}) {
  const Ws = getWsTransport();
  const auth = options.auth || { autoRefreshToken: false, persistSession: false };
  const realtime = {
    ...(options.realtime || {}),
    transport: (options.realtime && options.realtime.transport) || Ws,
  };
  return createClient(url, key, {
    ...options,
    auth,
    realtime,
  });
}

module.exports = { createSupabaseClient, getWsTransport };
