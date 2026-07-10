'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectChannels, buildContactChannels, classifyUrl } = require('./v8_lib_channel_spec');
const { extractContactsFromHtmlV2 } = require('./v8_lib_contact_enricher');

const SAMPLE_HTML = `
<html><body>
  <a href="mailto:sales@acme-furniture.com">Email</a>
  <a href="tel:+8613800138000">Call</a>
  <a href="https://wa.me/8613800138000">WhatsApp</a>
  <a href="https://t.me/acmebuyer">Telegram</a>
  <a href="https://www.instagram.com/acme_buyer/">IG</a>
  <a href="https://instagram.com/p/AbC123">a post (ignore)</a>
  <a href="https://www.linkedin.com/in/john-buyer">LinkedIn</a>
  <a href="https://x.com/acmebuyer">X</a>
  <a href="https://x.com/home">x home (ignore)</a>
  <a href="https://www.facebook.com/acmebuyerpage">FB</a>
  <a href="https://www.youtube.com/@acmebuyer">YT</a>
  <a href="https://www.tiktok.com/@acmebuyer">TT</a>
  <a href="skype:acme.buyer?chat">Skype</a>
  <p>微信号：acmebuyer88 欢迎询价</p>
</body></html>`;

function types(channels) {
  return new Set(channels.map((c) => c.type));
}

test('detectChannels 覆盖开放渠道集合（双仓镜像）', () => {
  const channels = detectChannels(SAMPLE_HTML, 'https://acme-furniture.com');
  const t = types(channels);
  for (const expected of ['telegram', 'instagram', 'linkedin', 'twitter', 'facebook', 'youtube', 'tiktok', 'skype', 'wechat']) {
    assert.ok(t.has(expected), `应探测到渠道: ${expected}`);
  }
  assert.ok(!t.has('email'), 'detectChannels 不应产出 email');
  assert.ok(!t.has('phone'), 'detectChannels 不应产出 phone');
});

test('detectChannels 过滤保留段噪音', () => {
  const channels = detectChannels(SAMPLE_HTML, 'https://acme-furniture.com');
  const twitter = channels.filter((c) => c.type === 'twitter').map((c) => c.value);
  assert.ok(twitter.every((v) => !v.endsWith('/home')), 'x.com/home 应被过滤');
  const ig = channels.filter((c) => c.type === 'instagram').map((c) => c.value);
  assert.ok(ig.every((v) => !v.includes('/p/')), 'instagram 帖子链接应被过滤');
});

test('社媒主页外链识别为 website', () => {
  const channels = detectChannels('<a href="https://acme-furniture.com">官网</a>', 'https://www.instagram.com/acme_buyer');
  assert.ok(types(channels).has('website'), '社媒主页外链应识别为 website');
});

test('extractContactsFromHtmlV2 统一 channels[] 含 email/phone/whatsapp + 社媒', () => {
  const res = extractContactsFromHtmlV2(SAMPLE_HTML, 'https://acme-furniture.com');
  const t = types(res.channels || []);
  for (const expected of ['email', 'phone', 'whatsapp', 'telegram', 'linkedin', 'instagram']) {
    assert.ok(t.has(expected), `统一 channels 应含: ${expected}`);
  }
  assert.ok((res.channels || []).every((c) => typeof c.confidence === 'number' && c.confidence > 0), '每条渠道应带 confidence');
  assert.ok(res.emails.length >= 1 && res.phones.length >= 1 && res.whatsapps.length >= 1, '旧字段仍产出');
});

test('buildContactChannels 从 L1 现有字段合成开放渠道（B3 写库）', () => {
  const channels = buildContactChannels({
    email: 'buyer@acme-furniture.com',
    phone: '+8613800138000',
    whatsapp: '+86 138 0013 8000',
    socialUrls: [
      'https://www.instagram.com/acme_buyer/',
      'https://www.linkedin.com/company/acme',
      'https://t.me/acmebuyer',
    ],
    extraChannels: [{ type: 'wechat', value: 'acmebuyer88', confidence: 0.55 }],
  });
  const t = types(channels);
  for (const expected of ['email', 'phone', 'whatsapp', 'instagram', 'linkedin', 'telegram', 'wechat']) {
    assert.ok(t.has(expected), `合成 channels 应含: ${expected}`);
  }
  const wa = channels.find((c) => c.type === 'whatsapp');
  assert.equal(wa.value, '+8613800138000', 'whatsapp 应规整为数字串');
  assert.ok(channels.every((c) => typeof c.confidence === 'number' && c.confidence > 0), '每条带 confidence');
});

test('buildContactChannels 去重同 type::value 取高分 + 空输入返回空', () => {
  assert.deepEqual(buildContactChannels({}), []);
  const dup = buildContactChannels({
    socialUrls: ['https://t.me/acmebuyer'],
    extraChannels: [{ type: 'telegram', value: 'https://t.me/acmebuyer', confidence: 0.99 }],
  });
  const tg = dup.filter((c) => c.type === 'telegram');
  assert.equal(tg.length, 1, '同一 telegram 应去重为 1 条');
  assert.equal(tg[0].confidence, 0.99, '去重保留高置信');
});

test('classifyUrl 对单条 social url 归类', () => {
  assert.equal(classifyUrl('https://www.linkedin.com/in/john-buyer').type, 'linkedin');
  assert.equal(classifyUrl('https://example.com/about'), null);
});
