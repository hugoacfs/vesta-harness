// vesta-voice connect path in a real browser (2026-09-25): Firefox's fake microphone lets the page place a
// call through the reverse-proxy path; then, with the offer request forced to fail, the page must return to
// idle with a note instead of sticking on "Connecting". VESTA_TARGET=prod for /voice/ (default staging).
const puppeteer = (await import('puppeteer-core')).default;
const target = process.env.VESTA_TARGET === 'prod' ? 'prod' : 'staging';
const useChrome = process.env.BROWSER === 'chrome';
const base = target === 'prod' ? 'https://vesta.tail22b555.ts.net/voice/' : 'https://vesta.tail22b555.ts.net/voice-staging/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await (useChrome
  ? puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  : puppeteer.launch({
    browser: 'firefox', headless: true, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox',
    extraPrefsFirefox: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.peerconnection.ice.obfuscate_host_addresses': false },
  }));
const state = p => p.evaluate(() => ({ state: document.querySelector('.shell').dataset.state, status: document.getElementById('status').textContent, notes: [...document.querySelectorAll('.line.note')].map(n => n.textContent).slice(-3) }));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 800 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(500);
  await page.click('#orb');
  let s = null; const t0 = Date.now();
  for (let i = 0; i < 40; i++) { await sleep(500); s = await state(page); if (s.state !== 'connecting') break; }
  console.log(`A. real call via ${target} (${useChrome ? 'chrome' : 'firefox'}): state=${s.state} status="${s.status}" after ${Date.now() - t0} ms notes=${JSON.stringify(s.notes)}`);
  await sleep(1500); await page.click('#end'); await sleep(1000);
  console.log('   after end:', JSON.stringify(await state(page)));

  // C. Hugo's phone flow: a call, a page refresh in the middle of it, a second call must connect.
  await page.click('#orb');
  for (let i = 0; i < 40; i++) { await sleep(500); s = await state(page); if (s.state !== 'connecting') break; }
  console.log(`C1. call before the refresh: state=${s.state} status="${s.status}"`);
  await sleep(1000);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await page.click('#orb');
  const t2 = Date.now();
  for (let i = 0; i < 40; i++) { await sleep(500); s = await state(page); if (s.state !== 'connecting') break; }
  console.log(`C2. call after the refresh: state=${s.state} status="${s.status}" after ${Date.now() - t2} ms notes=${JSON.stringify(s.notes)}`);
  await sleep(1000); await page.click('#end'); await sleep(800);

  // B. reload, make the offer fail (HTTP 500), tap: the page must give up and return to idle.
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  await page.evaluate(() => { const real = window.fetch; window.fetch = (u, o) => { const url = u instanceof Request ? u.url : String(u); return url.includes('api/offer') ? Promise.resolve(new Response('boom', { status: 500 })) : real(u, o); }; });
  await page.click('#orb');
  const t1 = Date.now();
  for (let i = 0; i < 40; i++) { await sleep(500); s = await state(page); if (s.state !== 'connecting') break; }
  console.log(`B. failed offer: state=${s.state} status="${s.status}" after ${Date.now() - t1} ms notes=${JSON.stringify(s.notes)}`);
  console.log('page errors:', JSON.stringify(errors));
} finally { await browser.close(); }
