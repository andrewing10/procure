/**
 * 单元验证 procure v8_lib_contact_enricher 的核心抽取能力。
 * 不真发 fetch，只用伪 HTML 走 extractContactsFromHtmlV2 / htmlToVisibleText。
 *
 * 用法：node scripts/verify-contact-enricher.js
 */

require('../load-env');
const {
  extractContactsFromHtmlV2,
  htmlToVisibleText,
  isLikelyValidEmail,
  isLikelyValidPhone,
  normalizePhone,
  llmExtractContactFromImage,
} = require('../v8_lib_contact_enricher');
const {
  capturePageScreenshot,
  isAnyScreenshotProviderAvailable,
  listAvailableScreenshotProviders,
} = require('../v8_lib_page_screenshot.cjs');

const homeHtml = `
<!doctype html>
<html lang="en">
<head><title>ORIZI Group</title></head>
<body>
<header><nav>
  <a href="/about">About</a>
  <a href="/products">Products</a>
  <a href="/contact-us">联系我们</a>
  <a href="https://wa.me/60123456789">WhatsApp</a>
</nav></header>
<footer>
  <h3>Get in touch</h3>
  <p>📧 <a href="mailto:contact@orizigroup.com">contact@orizigroup.com</a></p>
  <p>📞 <a href="tel:+60377105555">+60 3-7710 5555</a></p>
  <p>📱 <a href="https://wa.me/60123456789">+60 12-345 6789</a></p>
  <p>© 2026 ORIZI Group Sdn Bhd</p>
</footer>
</body></html>`;

const contactHtml = `
<!doctype html>
<html>
<head><title>Contact — ORIZI Group</title></head>
<body>
<h1>Contact Us</h1>
<div class="card">
  <h3>Purchasing Department</h3>
  <p>Name: Mr. John Tan, Purchasing Manager</p>
  <p>Email: john.tan[at]orizigroup[dot]com</p>
  <p>Direct: 03-7710 5555 ext. 122</p>
  <p>Mobile: <a href="tel:+60127778888">+60 12-777 8888</a></p>
</div>
<div class="card">
  <h3>Sales</h3>
  <p>Sales: <a href="mailto:sales@orizigroup.com?subject=Inquiry">sales@orizigroup.com</a></p>
  <p>Tel: (03) 1234 5678</p>
</div>
<div class="card">
  <h3>Customer Service</h3>
  <p>support@orizigroup.com (24/7)</p>
  <p>Hotline: 1300-88-1234</p>
</div>
</body></html>`;

const spaHtml = `
<!doctype html>
<html><head><title>ORIZI</title></head>
<body>
  <div id="root">
    <p>Modern OEM manufacturer based in Kuala Lumpur, Malaysia.</p>
    <p>For purchasing enquiries please contact our team via the form below.</p>
    <p>采购经理：王先生（销售总监）</p>
    <p>办公电话：+603-7710 5555</p>
  </div>
  <script>window.contact = { email: "contact@orizigroup.com" }</script>
</body></html>`;

const CASES = [
  {
    name: 'home footer (mailto + tel + wa.me + 内链发现)',
    html: homeHtml,
    url: 'https://orizigroup.com/',
    expect: {
      hasEmail: ['contact@orizigroup.com'],
      hasPhone: ['+60377105555'],
      hasWhatsapp: ['60123456789'],
      contactLinkContains: '/contact-us',
    },
  },
  {
    name: 'contact 子页 (反混淆 + 不带+本地号 + 多角色)',
    html: contactHtml,
    url: 'https://orizigroup.com/contact-us',
    expect: {
      hasEmail: ['sales@orizigroup.com', 'john.tan@orizigroup.com', 'support@orizigroup.com'],
      hasPhone: ['+60127778888'],
      hasWhatsapp: [],
      contactLinkContains: null,
    },
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const out = extractContactsFromHtmlV2(c.html, c.url, 8);
  const missingEmail = c.expect.hasEmail.filter((e) => !out.emails.includes(e));
  const missingPhone = c.expect.hasPhone.filter((p) => !out.phones.includes(p));
  const missingWa = c.expect.hasWhatsapp.filter((w) => !out.whatsapps.includes(w));
  const contactLinkOk = c.expect.contactLinkContains
    ? out.contactLinks.some((l) => l.includes(c.expect.contactLinkContains))
    : true;
  const ok = !missingEmail.length && !missingPhone.length && !missingWa.length && contactLinkOk;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      emails:    [${out.emails.join(', ')}]`);
  console.log(`      phones:    [${out.phones.join(', ')}]`);
  console.log(`      whatsapps: [${out.whatsapps.join(', ')}]`);
  console.log(`      contactLinks: [${out.contactLinks.join(', ')}]`);
  if (!ok) {
    if (missingEmail.length) console.log(`      MISSING emails:    ${missingEmail.join(', ')}`);
    if (missingPhone.length) console.log(`      MISSING phones:    ${missingPhone.join(', ')}`);
    if (missingWa.length) console.log(`      MISSING whatsapps: ${missingWa.join(', ')}`);
    if (!contactLinkOk) console.log(`      MISSING contact link: ${c.expect.contactLinkContains}`);
  }
  console.log('');
}

console.log('[htmlToVisibleText]');
const vt = htmlToVisibleText(spaHtml);
const hasPhone = vt.includes('7710 5555');
const hasRole = vt.includes('采购经理');
const hasScript = vt.includes('window.contact');
console.log(`  visible text 长度: ${vt.length}`);
console.log(`  含"7710 5555": ${hasPhone}`);
console.log(`  含"采购经理":   ${hasRole}`);
console.log(`  脚本被剥离:    ${!hasScript}`);
const vtOk = hasPhone && hasRole && !hasScript;
if (vtOk) pass++;
else fail++;

console.log('');

// ── ADV-2：vision 抽取链路烟雾测（仅在配置 SCREENSHOTONE_API_KEY 时跑） ─
console.log('[ADV-2 vision pipeline]');
console.log(`  isAnyScreenshotProviderAvailable: ${isAnyScreenshotProviderAvailable()}`);
console.log(`  providers available: [${listAvailableScreenshotProviders().join(', ')}]`);

if (isAnyScreenshotProviderAvailable()) {
  (async () => {
    let visionPass = 0;
    let visionFail = 0;
    // Test 1: 真实有 contact 的页面，应当抽到 person
    const t0 = Date.now();
    const shot = await capturePageScreenshot('https://www.zoho.com/contact.html', { timeoutMs: 25_000 });
    if (!shot) {
      console.log(`  FAIL  截图失败（${Date.now() - t0}ms）`);
      visionFail++;
    } else {
      console.log(`  PASS  截图成功 ${Math.round(shot.bytes / 1024)}KB（${shot.provider}, ${Date.now() - t0}ms）`);
      visionPass++;
      const t1 = Date.now();
      const vis = await llmExtractContactFromImage({
        imageBase64: shot.base64,
        imageMime: shot.mime,
        companyName: 'Zoho Corp',
        domain: 'zoho.com',
      });
      console.log(`        vision LLM: ok=${vis.ok}  persons=${vis.persons.length}  reason=${vis.reason || '—'}  ${Date.now() - t1}ms`);
      for (const p of vis.persons.slice(0, 5)) {
        console.log(`          · role=${p.role || '—'}  email=${p.email || '—'}  phone=${p.phone || '—'}  conf=${p.confidence}`);
      }
      if (vis.ok && vis.persons.length > 0) {
        const allDomain = vis.persons.every((p) => !p.email || /@(?:zoho|zohocorp)\./.test(p.email));
        if (allDomain) {
          console.log('        PASS  所有 email 为 zoho 同域 ✓');
          visionPass++;
        } else {
          console.log('        FAIL  存在非同域 email');
          visionFail++;
        }
      } else {
        console.log('        FAIL  vision 应当抽到 ≥1 person');
        visionFail++;
      }
    }
    // Test 2: 输入 invalid imageBase64 → 应当软失败
    const visBad = await llmExtractContactFromImage({ imageBase64: '', imageMime: 'image/jpeg' });
    if (!visBad.ok && visBad.reason === 'no_image') {
      console.log('  PASS  invalid imageBase64 → 软失败 reason=no_image ✓');
      visionPass++;
    } else {
      console.log(`  FAIL  invalid imageBase64 应当 reason=no_image，实际 ${visBad.reason}`);
      visionFail++;
    }
    pass += visionPass;
    fail += visionFail;
    console.log('');
    console.log(`${pass}/${pass + fail} pass`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => {
    console.error('vision pipeline 异常:', e);
    process.exit(1);
  });
} else {
  console.log('  SKIP  capability_missing（未配置 SCREENSHOTONE_API_KEY），跳过 vision case');
  console.log('');
  console.log(`${pass}/${pass + fail} pass`);
  process.exit(fail === 0 ? 0 : 1);
}
