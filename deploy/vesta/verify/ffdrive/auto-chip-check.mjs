// M5 on staging: New Session shows the Auto chip; after the first message the chip reads the routed mode.
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
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /new session/i.test(x.textContent)); if (!b) return false; b.click(); return true; });
  console.log('New Session clicked:', clicked); await sleep(3000);
  const chipsBefore = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(t => /auto|ops|build|research|companion|incognito|routine/i.test(t)).slice(0, 12));
  console.log('mode-ish chips before:', JSON.stringify(chipsBefore));
  await page.screenshot({ path: `${shots}/auto-before.png` });
  const typed = await page.evaluate(() => { const ta = document.querySelector('textarea'); if (!ta) return false; ta.focus(); return true; });
  console.log('composer focused:', typed);
  await page.keyboard.type('In two sentences, what is the difference between Landlock and AppArmor? No tools needed.');
  await page.keyboard.press('Enter');
  await sleep(4000);
  const chipsAfter = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(t => /auto|ops|build|research|companion|incognito|routine/i.test(t)).slice(0, 12));
  console.log('mode-ish chips after 4 s:', JSON.stringify(chipsAfter));
  await page.screenshot({ path: `${shots}/auto-after.png` });
  await sleep(20000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('page text excerpt:', JSON.stringify(text.replace(/\n+/g, ' | ').slice(0, 700)));
  await page.screenshot({ path: `${shots}/auto-reply.png` });
  console.log('errors:', JSON.stringify(errors));
} finally { await browser.close(); }
