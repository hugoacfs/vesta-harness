// vesta-voice, turn hearing seen from the page (2026-09-29, staging): Chrome plays a recorded sentence with
// pauses as its microphone; the page must show ONE "you" bubble whose text grows into the whole sentence,
// and Vesta must answer once. WAV=/path/to/48k-16bit.wav (default: the paused-copilot probe).
const puppeteer = (await import('puppeteer-core')).default;
const wav = process.env.WAV || '/tmp/vesta-shots/paused-copilot-48k.wav';
const base = 'https://vesta.tail22b555.ts.net/voice-staging/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const read = p => p.evaluate(() => ({ state: document.querySelector('.shell').dataset.state, status: document.getElementById('status').textContent, you: [...document.querySelectorAll('.line.you')].map(n => (n.classList.contains('interim') ? '~ ' : '') + n.textContent.replace(/^you/, '').trim()), vesta: [...document.querySelectorAll('.line.vesta')].map(n => n.textContent.replace(/^vesta/, '').trim()) }));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(300);
  await page.click('#orb');
  const seen = []; let s; let peak = 0;
  for (let i = 0; i < 110; i++) {
    await sleep(400); s = await read(page);
    peak = Math.max(peak, await page.evaluate(() => parseFloat(document.getElementById('meter-you').style.width) || 0));
    const tag = JSON.stringify(s.you);
    if (seen[seen.length - 1] !== tag) seen.push(tag);
    if (s.vesta.length >= 1 && s.state === 'listening' && i > 50) break;
  }
  console.log('"you" bubbles over time:'); for (const t of seen) console.log('  ', t);
  console.log('final: you bubbles =', s.you.length, '| vesta lines =', s.vesta.length, '| first vesta line:', JSON.stringify((s.vesta[0] || '').slice(0, 120)));
  console.log('microphone meter peak on the page:', peak + '%', '| state', s.state, '| status', s.status);
  console.log('page errors:', JSON.stringify(errors));
  await page.screenshot({ path: '/tmp/vesta-shots/voice-hearing.png' });
  await page.click('#end').catch(() => {}); await sleep(600);
} finally { await browser.close(); }
