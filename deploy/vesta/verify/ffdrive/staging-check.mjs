// Pipeline S (2026-09-25): the staging harness says "staging" (tab title, sidebar wordmark) and the
// staging voice page says so too. Screenshots to /tmp/vesta-shots.
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
  const info = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')].filter(s => /^vesta$/i.test(s.textContent.trim()));
    const name = spans[0]?.parentElement?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return { title: document.title, wordmark: name, home: !!document.querySelector('a[aria-label="Vesta home"]') };
  });
  console.log('harness staging:', JSON.stringify(info));
  await page.screenshot({ path: `${shots}/staging-harness-top.png`, clip: { x: 0, y: 0, width: 420, height: 140 } });
  console.log('harness errors:', JSON.stringify(errors));
  const voice = await browser.newPage(); await voice.setViewport({ width: 1280, height: 800 });
  await voice.goto('https://vesta.tail22b555.ts.net:8483/', { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(800);
  const v = await voice.evaluate(() => ({ title: document.title, env: document.documentElement.dataset.env, wordmark: document.querySelector('.name').textContent.replace(/\s+/g, ' ').trim(), home: document.getElementById('home').href }));
  console.log('voice staging:', JSON.stringify(v));
  await voice.screenshot({ path: `${shots}/staging-voice-top.png`, clip: { x: 0, y: 0, width: 1280, height: 70 } });
} finally { await browser.close(); }
