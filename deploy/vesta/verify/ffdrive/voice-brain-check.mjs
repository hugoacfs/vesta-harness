// vesta-voice, the brain grace seen from the page (2026-09-29): with the staging instance pointed at the flaky
// gateway stand-in (tools/flaky_proxy.py --fail-first 4), a typed question must show "brain restarting" in the
// status pill, her apology in the transcript, then the real answer and the pill back to "on the call".
// Chrome with a fake microphone; staging only (the stand-in is never pointed at production).
const puppeteer = (await import('puppeteer-core')).default;
const base = 'https://vesta.tail22b555.ts.net/voice-staging/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const read = p => p.evaluate(() => ({ state: document.querySelector('.shell').dataset.state, status: document.getElementById('status').textContent, cls: document.getElementById('status').className, lines: [...document.querySelectorAll('.line')].map(n => n.className.replace('line ', '') + ': ' + n.textContent.replace(/^(vesta|you)/, '').trim()) }));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(500);
  await page.click('#orb');
  let s; for (let i = 0; i < 40; i++) { await sleep(500); s = await read(page); if (s.state !== 'connecting') break; }
  console.log('connected:', s.state, '|', s.status);
  await page.click('#mute');                       // the fake microphone beeps; the question is typed instead
  await page.type('#typed-text', 'What time is it?'); await page.keyboard.press('Enter');
  const seen = []; let shot = false;
  for (let i = 0; i < 90; i++) {
    await sleep(500); s = await read(page);
    const tag = `${s.status} [${s.cls.replace('status', '').trim() || 'plain'}]`;
    if (seen[seen.length - 1] !== tag) seen.push(tag);
    if (!shot && /brain/.test(s.status)) { await page.screenshot({ path: '/tmp/vesta-shots/voice-brain-restarting.png' }); shot = true; }
    if (seen.length > 1 && /on the call/.test(s.status) && s.lines.filter(l => l.startsWith('vesta')).length >= 2 && s.state === 'listening') break;
  }
  console.log('status sequence:', JSON.stringify(seen));
  console.log('transcript:', JSON.stringify(s.lines));
  console.log('page errors:', JSON.stringify(errors));
  await page.screenshot({ path: '/tmp/vesta-shots/voice-brain-after.png' });
  await page.click('#end'); await sleep(800);
} finally { await browser.close(); }
