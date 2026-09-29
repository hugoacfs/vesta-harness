// vesta-voice, one bubble per turn (2026-09-29, staging): the page is handed the messages the service sends
// while it hears a sentence in pieces; it must show one bubble that grows, greyed until final, and a new
// bubble for the next turn. (Headless Chrome on the Mac cannot play a file as its microphone.)
const puppeteer = (await import('puppeteer-core')).default;
const base = 'https://vesta.tail22b555.ts.net/voice-staging/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const you = p => p.evaluate(() => [...document.querySelectorAll('.line.you')].map(n => (n.classList.contains('interim') ? '~ ' : '') + n.textContent.replace(/^you/, '').trim()));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 430, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(300);
  await page.click('#orb');
  for (let i = 0; i < 40; i++) { await sleep(500); if (await page.evaluate(() => window.vv.ready)) break; }
  await page.click('#mute');
  const say = (d) => page.evaluate((d) => window.vv.inject('onServerMessage', d), d);
  await say({ type: 'hearing', mode: 'turn' });
  const steps = [
    { type: 'heard', text: 'How do I...', final: false, epoch: 1 },
    { type: 'heard', text: 'How do I, like, set up an API key?', final: false, epoch: 1 },
    { type: 'heard', text: 'How do I, like, set up an API key?', final: true, epoch: 1 },
    { type: 'heard', text: 'How do I, like, set up an API key for Copilot, that is,', final: false, epoch: 1 },
    { type: 'heard', text: 'How do I, like, set up an API key for Copilot, that is, GitHub Copilot?', final: true, epoch: 1 },
  ];
  for (const d of steps) { await say(d); await sleep(150); console.log(JSON.stringify(await you(page))); }
  await page.evaluate(() => { window.vv.inject('onUserTranscript', { text: 'a fragment that must be ignored', final: true }); window.vv.inject('onBotTtsText', { text: 'You create it in your GitHub settings, under developer settings.' }); });
  await say({ type: 'heard', text: 'Thanks.', final: true, epoch: 2 }); await sleep(150);
  const end = await you(page);
  console.log(JSON.stringify(end));
  console.log(end.length === 2 && !end[0].startsWith('~') && end[0].endsWith('GitHub Copilot?') ? 'PASS: one bubble per turn' : 'FAIL');
  console.log('page errors:', JSON.stringify(errors));
  await page.screenshot({ path: '/tmp/vesta-shots/voice-bubbles.png' });
  await page.click('#end').catch(() => {}); await sleep(500);
} finally { await browser.close(); }
