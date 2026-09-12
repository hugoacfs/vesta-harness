// Routines page (v2) on staging: open the app, click the Routines global panel, read the list,
// open the first routine's detail, open the New routine form; screenshots at desktop and phone widths.
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
  const clicked = await page.evaluate(() => { const n = document.querySelector('nav[aria-label="Global panels"]'); const b = n && [...n.querySelectorAll('button')].find(x => /routines/i.test(x.getAttribute('aria-label') || x.textContent)); if (!b) return false; b.click(); return true; });
  console.log('clicked Routines:', clicked); await sleep(3000);
  const sel = 'section[aria-labelledby="vesta-routines-title"]';
  const list = await page.evaluate((sel) => { const s = document.querySelector(sel); if (!s) return null; const nav = s.querySelector('nav'); return { title: s.querySelector('h2')?.textContent, rows: nav ? [...nav.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 100)) : null, note: [...s.querySelectorAll('p')].map(p => p.textContent.trim().slice(0, 80)) }; }, sel);
  console.log('list:', JSON.stringify(list));
  await page.screenshot({ path: `${shots}/routines-page-list.png` });
  const opened = await page.evaluate((sel) => { const s = document.querySelector(sel); const b = s?.querySelector('nav button'); if (!b) return false; b.click(); return true; }, sel);
  console.log('opened first routine:', opened); await sleep(2500);
  const detail = await page.evaluate((sel) => { const s = document.querySelector(sel); const a = s?.querySelector('article'); if (!a) return null; return { title: a.querySelector('h3')?.textContent.trim().slice(0, 80), buttons: [...a.querySelectorAll('button')].map(b => b.textContent.trim()), dl: [...a.querySelectorAll('dl dt')].map((dt, i) => dt.textContent + ': ' + (a.querySelectorAll('dl dd')[i]?.textContent.trim().slice(0, 60) ?? '')), headings: [...a.querySelectorAll('h4')].map(h => h.textContent), runsRows: a.querySelectorAll('tbody tr').length }; }, sel);
  console.log('detail:', JSON.stringify(detail));
  await page.screenshot({ path: `${shots}/routines-page-detail.png`, fullPage: true });
  const newClicked = await page.evaluate((sel) => { const s = document.querySelector(sel); const b = [...(s?.querySelectorAll('button') ?? [])].find(x => /new routine/i.test(x.textContent)); if (!b) return false; b.click(); return true; }, sel);
  console.log('New routine:', newClicked); await sleep(1000);
  const form = await page.evaluate((sel) => { const f = document.querySelector(sel + ' form'); if (!f) return null; return { title: f.querySelector('h3')?.textContent, labels: [...f.querySelectorAll('label > span')].map(x => x.textContent.trim().slice(0, 50)), kinds: [...(f.querySelector('select')?.options ?? [])].map(o => o.textContent) }; }, sel);
  console.log('form:', JSON.stringify(form));
  await page.screenshot({ path: `${shots}/routines-page-form.png`, fullPage: true });
  await page.setViewport({ width: 390, height: 780 }); await sleep(1000);
  await page.screenshot({ path: `${shots}/routines-page-phone.png` });
  console.log('errors:', JSON.stringify(errors));
} finally { await browser.close(); }
