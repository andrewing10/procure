'use strict';

// B2：社媒主页深抽取（无官网域名的私域线索）单测。
// enrichFromProfileUrls 涉及网络 fetch，这里测可离线验证的纯逻辑：
//   - collectProfileUrls：去重 / 仅 http(s) / 截断
//   - finalizeEnrich：邮箱质量门 + primary_* 回填 + 开放渠道对齐
//   - extractContactsFromHtmlV2：社媒主页里链出的官网识别为 website 渠道（抽取深度）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectProfileUrls,
  finalizeEnrich,
  extractContactsFromHtmlV2,
} = require('./v8_lib_contact_enricher');

function types(channels) {
  return new Set((channels || []).map((c) => c.type));
}

test('collectProfileUrls 去重 / 仅 http(s) / 截断', () => {
  const urls = collectProfileUrls({
    social_profile_urls: [
      'https://www.instagram.com/acme_buyer/',
      'https://www.instagram.com/acme_buyer/', // 重复
      'ftp://nope.com', // 非 http
      'https://t.me/acmebuyer',
    ],
    profile_url: 'https://www.linkedin.com/company/acme',
    source_url: 'https://www.instagram.com/acme_buyer/', // 与首条重复
  });
  assert.ok(urls.includes('https://www.instagram.com/acme_buyer/'));
  assert.ok(urls.includes('https://t.me/acmebuyer'));
  assert.ok(urls.includes('https://www.linkedin.com/company/acme'));
  assert.ok(!urls.some((u) => u.startsWith('ftp')), '非 http(s) 应被剔除');
  assert.equal(urls.length, 3, '重复 URL 应去重');
});

test('社媒主页 HTML：抽取深度识别官网外链为 website 渠道', () => {
  const profileHtml = `
    <html><head><title>Acme Buyer (@acme_buyer)</title></head><body>
      <a href="https://acme-furniture.com">Visit our website</a>
      <a href="https://t.me/acmebuyer">Telegram</a>
      <a href="mailto:buyer@acme-furniture.com">Email</a>
      <p>WhatsApp: <a href="https://wa.me/8613800138000">chat</a></p>
    </body></html>`;
  const res = extractContactsFromHtmlV2(profileHtml, 'https://www.instagram.com/acme_buyer');
  const t = types(res.channels);
  assert.ok(t.has('website'), '社媒主页链出的官网应识别为 website 渠道');
  assert.ok(t.has('telegram'), '应识别 telegram 渠道');
  assert.ok(t.has('email'), '应识别 email 渠道');
  assert.ok(t.has('whatsapp'), '应识别 whatsapp 渠道');
});

test('finalizeEnrich：邮箱质量门拦截 placeholder，保留可用渠道并回填 primary_*', () => {
  const result = {
    filled: false,
    primary_email: null,
    primary_phone: null,
    primary_whatsapp: null,
    via: 'profile',
    fetch_log: [],
    llm_persons: [],
    channels: [],
    any_blocked: false,
    waterfall: [],
    _cost_units: 0,
  };
  const accumulator = {
    emails: new Set(['noreply@example.com', 'buyer@gmail.com']),
    phones: new Set(['+8613800138000']),
    whatsapps: new Set(['8613800138000']),
    channels: new Map([
      ['telegram::https://t.me/acmebuyer', { type: 'telegram', value: 'https://t.me/acmebuyer', source: 'href', confidence: 0.85 }],
      ['email::noreply@example.com', { type: 'email', value: 'noreply@example.com', source: 'regex', confidence: 0.6 }],
    ]),
  };
  const out = finalizeEnrich(result, accumulator, ''); // 无 host → 放宽到拦 placeholder/aggregator
  const t = types(out.channels);
  assert.ok(t.has('telegram'), '社媒渠道应保留');
  assert.ok(t.has('phone') && t.has('whatsapp'), 'phone/whatsapp 渠道应补齐');
  // placeholder noreply@ 应被质量门剔除，对应 email 渠道也清掉
  const emails = out.channels.filter((c) => c.type === 'email').map((c) => c.value);
  assert.ok(!emails.includes('noreply@example.com'), 'placeholder 邮箱渠道应被清除');
  assert.equal(out.primary_phone, '+8613800138000', 'primary_phone 应回填');
  assert.equal(out.filled, true, '有 phone/whatsapp → filled=true');
});

test('finalizeEnrich：仅社媒渠道（无 email/phone/wa）→ filled=false 但渠道保留', () => {
  const result = {
    filled: false, primary_email: null, primary_phone: null, primary_whatsapp: null,
    via: 'profile', fetch_log: [], llm_persons: [], channels: [], any_blocked: false,
    waterfall: [], _cost_units: 0,
  };
  const accumulator = {
    emails: new Set(), phones: new Set(), whatsapps: new Set(),
    channels: new Map([
      ['instagram::https://instagram.com/acme', { type: 'instagram', value: 'https://instagram.com/acme', source: 'href', confidence: 0.75 }],
      ['linkedin::https://linkedin.com/company/acme', { type: 'linkedin', value: 'https://linkedin.com/company/acme', source: 'href', confidence: 0.85 }],
    ]),
  };
  const out = finalizeEnrich(result, accumulator, '');
  assert.equal(out.filled, false, '无直接联系方式 → filled=false');
  assert.equal(out.channels.length, 2, '社媒渠道应原样保留（B2 关键：不因 filled=false 丢渠道）');
});
