// Archived panel on staging: open the app, archive a session via the UI? (no: use the panel only) —
// click the "Archived" panel-list entry, screenshot at desktop and phone widths, read the rows.
const puppeteer = (await import('puppeteer-core')).default;
import { execFileSync } from 'node:child_process';
const url = execFileSync('ssh', ['-o', 'BatchMode=yes', 'vesta', '~/.local/bin/vesta-url staging'], { encoding: 'utf8' }).trim();
const shots = '/tmp/vesta-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 860 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => /continue/i.test(x.textContent)); b?.click(); }); await sleep(1500);
  const nav = await page.evaluate(() => { const n = document.querySelector('nav[aria-label="Global panels"]'); return n ? [...n.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()) : null; });
  console.log('global panels:', JSON.stringify(nav));
  const clicked = await page.evaluate(() => { const n = document.querySelector('nav[aria-label="Global panels"]'); const b = n && [...n.querySelectorAll('button')].find(x => /archived/i.test(x.getAttribute('aria-label') || x.textContent)); if (!b) return false; b.click(); return true; });
  console.log('clicked Archived:', clicked); await sleep(2500);
  const panel = await page.evaluate(() => { const s = document.querySelector('section[aria-labelledby="vesta-archived-title"]'); if (!s) return null; return { title: s.querySelector('h2')?.textContent, rows: [...s.querySelectorAll('li')].map(li => li.textContent.trim().slice(0, 120)), note: s.querySelector('p')?.textContent }; });
  console.log('panel:', JSON.stringify(panel));
  await page.screenshot({ path: `${shots}/archived-desktop.png` });
  if (panel && panel.rows.length) {
    // open the inline confirm on the first row, screenshot, cancel
    await page.evaluate(() => { const s = document.querySelector('section[aria-labelledby="vesta-archived-title"]'); [...s.querySelectorAll('li')][0].querySelectorAll('button')[1].click(); }); await sleep(500);
    console.log('confirm shown:', await page.evaluate(() => !!document.querySelector('section[aria-labelledby="vesta-archived-title"] [role="group"]')));
    await page.screenshot({ path: `${shots}/archived-confirm.png` });
    await page.evaluate(() => { const g = document.querySelector('section[aria-labelledby="vesta-archived-title"] [role="group"]'); [...g.querySelectorAll('button')].pop().click(); }); await sleep(300);
  }
  await page.setViewport({ width: 390, height: 780 }); await sleep(1000);
  await page.screenshot({ path: `${shots}/archived-phone.png` });
  console.log('errors:', JSON.stringify(errors));
} finally { await browser.close(); }
