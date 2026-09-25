// vesta-voice behind the reverse proxy (2026-09-25): the page under a path loads its relative assets,
// resolves the offer URL under the path, keeps the home link, and shows the instance in the wordmark.
// VESTA_TARGET=prod checks /voice/ (after the promotion); default is /voice-staging/.
const puppeteer = (await import('puppeteer-core')).default;
const target = process.env.VESTA_TARGET === 'prod' ? 'prod' : 'staging';
const base = target === 'prod' ? 'https://vesta.tail22b555.ts.net/voice/' : 'https://vesta.tail22b555.ts.net/voice-staging/';
const shots = '/tmp/vesta-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  const errors = [], failed = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(base.replace(/\/$/, ''), { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(800);
  const info = await page.evaluate(async () => ({
    url: location.href,
    title: document.title,
    env: document.documentElement.dataset.env,
    wordmark: document.querySelector('.name').textContent.replace(/\s+/g, ' ').trim(),
    home: document.getElementById('home').href,
    offer: new URL('api/offer', document.baseURI).href,
    fonts: { inter: document.fonts.check('16px Inter'), grotesk: document.fonts.check('16px "Space Grotesk"'), mono: document.fonts.check('12px "JetBrains Mono"') },
    client: typeof window.vv === 'object',
    orbLabel: document.getElementById('orb').getAttribute('aria-label'),
  }));
  console.log(`voice ${target} path:`, JSON.stringify(info));
  console.log('errors:', JSON.stringify(errors), '| failed requests:', JSON.stringify(failed));
  await page.screenshot({ path: `${shots}/voice-path-${target}.png`, clip: { x: 0, y: 0, width: 1280, height: 300 } });
} finally { await browser.close(); }
