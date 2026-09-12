// New Session preset chip on staging: open the app, start a new session in dsh-chat, open the preset chip, list entries.
const puppeteer = (await import('puppeteer-core')).default;
import { execFileSync } from 'node:child_process';
const url = execFileSync('ssh', ['-o', 'BatchMode=yes', 'vesta', '~/.local/bin/vesta-url staging'], { encoding: 'utf8' }).trim();
const shots = '/tmp/vesta-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 860 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => /continue/i.test(x.textContent)); b?.click(); }); await sleep(1200);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'New session in dsh-chat')?.click()); await sleep(2500);
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 40)).filter(Boolean));
  console.log('buttons:', JSON.stringify(buttons.slice(0, 60)));
  const chip = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "vesta-ops" || /^(Ops|Vesta Default)$/.test(x.textContent.trim())); if (!b) return null; b.click(); return (b.getAttribute("aria-label") || b.textContent.trim()); });
  console.log('clicked chip:', chip); await sleep(800);
  const entries = await page.evaluate(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="listbox"] *, [role="menu"] *')].map(e => e.textContent.trim().slice(0, 60)).filter(Boolean));
  console.log('entries:', JSON.stringify([...new Set(entries)].slice(0, 30)));
  await page.screenshot({ path: `${shots}/mode-picker.png` });
  console.log('errors:', JSON.stringify(errors));
} finally { await browser.close(); }
