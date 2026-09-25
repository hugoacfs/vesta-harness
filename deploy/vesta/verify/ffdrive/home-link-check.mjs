// Home links (2026-09-25): the staging harness sidebar foot carries "Vesta home" (wide and rail);
// the vesta-voice page header carries "‹ home". Screenshots to /tmp/vesta-shots.
const puppeteer = (await import('puppeteer-core')).default;
import { execFileSync } from 'node:child_process';
const url = execFileSync('ssh', ['-o', 'BatchMode=yes', 'vesta', '~/.local/bin/vesta-url staging'], { encoding: 'utf8' }).trim();
const shots = '/tmp/vesta-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => /continue/i.test(x.textContent)); b?.click(); }); await sleep(1500);
  const link = await page.evaluate(() => { const a = document.querySelector('a[aria-label="Vesta home"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { href: a.getAttribute('href'), resolved: a.href, text: a.textContent.trim(), title: a.getAttribute('title'), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; });
  console.log('harness wide link:', JSON.stringify(link));
  await page.screenshot({ path: `${shots}/home-harness-wide.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });
  const toggled = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /collapse|close sidebar|hide sidebar|toggle sidebar/i.test(x.getAttribute('aria-label') || '')); if (!b) return null; b.click(); return b.getAttribute('aria-label'); });
  console.log('sidebar toggle clicked:', JSON.stringify(toggled)); await sleep(800);
  const rail = await page.evaluate(() => { const a = document.querySelector('a[aria-label="Vesta home"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { text: a.textContent.trim(), title: a.getAttribute('title'), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; });
  console.log('harness rail link:', JSON.stringify(rail));
  await page.screenshot({ path: `${shots}/home-harness-rail.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });
  console.log('harness errors:', JSON.stringify(errors));

  const voice = await browser.newPage();
  for (const [name, w, h] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    await voice.setViewport({ width: w, height: h });
    await voice.goto('https://vesta.tail22b555.ts.net:8482/', { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(800);
    const l = await voice.evaluate(() => { const a = document.getElementById('home'); const r = a.getBoundingClientRect(); const cs = getComputedStyle(a.querySelector('.label')); return { href: a.href, text: a.textContent.trim(), labelShown: cs.display !== 'none', box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], headerWidth: Math.round(document.querySelector('.top').getBoundingClientRect().width), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
    console.log(`voice ${name}:`, JSON.stringify(l));
    await voice.screenshot({ path: `${shots}/home-voice-${name}.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 240) } });
  }
} finally { await browser.close(); }
