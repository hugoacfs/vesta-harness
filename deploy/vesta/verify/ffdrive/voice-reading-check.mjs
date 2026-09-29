// vesta-voice, the reading test page (2026-09-29, staging): Chrome with a recorded file as its microphone
// walks through the script; the service must save the recording, the marks and the script.
const puppeteer = (await import('puppeteer-core')).default;
const wav = process.env.WAV || '/tmp/vesta-shots/paused-copilot-48k.wav';
const base = 'https://vesta.tail22b555.ts.net/voice-staging/app/read.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 430, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 }); await sleep(300);
  console.log('intro:', JSON.stringify(await page.$eval('#intro', n => n.textContent)));
  await page.click('#start');
  for (let i = 0; i < 40; i++) { await sleep(500); if (await page.$eval('#status', n => n.textContent) === 'recording') break; }
  console.log('status:', await page.$eval('#status', n => n.textContent), '| first sentence:', JSON.stringify(await page.$eval('#sentence', n => n.textContent)), '|', await page.$eval('#progress', n => n.textContent));
  await page.screenshot({ path: '/tmp/vesta-shots/voice-reading.png' });
  let steps = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    if (i === 2) await page.click('#redo');
    const label = await page.$eval('#next', n => n.textContent);
    await page.click('#next'); steps += 1;
    if (label === 'Finish') break;
  }
  await sleep(2500);
  console.log('steps:', steps, '| end:', JSON.stringify(await page.$eval('#sentence', n => n.textContent)), '| status:', await page.$eval('#status', n => n.textContent));
  console.log('page errors:', JSON.stringify(errors));
} finally { await browser.close(); }
