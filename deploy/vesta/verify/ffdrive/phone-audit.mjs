// Phone audit (proposal branch pwa-proposal-sonnet): the harness at an iPhone-sized, touch-emulated Chrome.
// NOT YET RUN: written without access to the live harness or a browser. Expect to fix selectors on the first run.
//
//   cd deploy/vesta/verify/ffdrive && npm install
//   node phone-audit.mjs                    # staging
//   VESTA_TARGET=prod node phone-audit.mjs  # production
//
// What it checks (headless Chrome on the Mac, like voice-connect-check.mjs; screenshots to /tmp/vesta-shots, create it):
//   - the page does not scroll sideways at 390 px;
//   - the viewport meta carries viewport-fit=cover, and, where Chrome supports the CDP safe-area override, that the
//     body is padded by the simulated notch / home-indicator insets and the header sits below the notch;
//   - every editable field is at least 16 px (iOS zooms the page on focus below that);
//   - interactive elements smaller than 44 px in either dimension (Apple's minimum target), listed by label;
//   - sw.js and the manifest are served, and sw.js has no fetch handler;
//   - the phone-alerts row in the sidebar foot (present only when the Host runs the push channel).
// What it cannot check: the on-screen keyboard, Web Push, the installed-app cookie, anything that needs a real iPhone;
// use the phone checklist in deploy/vesta/README.md for those.
const puppeteer = (await import('puppeteer-core')).default;
import { execFileSync } from 'node:child_process';

const target = process.env.VESTA_TARGET === 'prod' ? 'prod' : 'staging';
const url = execFileSync('ssh', ['-o', 'BatchMode=yes', 'vesta', `~/.local/bin/vesta-url ${target}`], { encoding: 'utf8' }).trim();
const shots = '/tmp/vesta-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 }; // an iPhone with a Dynamic Island, portrait
const PHONE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const problems = [];
const note = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
try {
  const page = await browser.newPage();
  await page.setUserAgent(PHONE.userAgent);
  await page.setViewport(PHONE.viewport);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  // Simulated notch and home indicator (experimental CDP; older Chromes refuse it).
  let insetsApplied = false;
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSETS });
    insetsApplied = true;
  } catch (e) {
    console.log(`note safe-area override unavailable (${String(e.message).slice(0, 80)}); padding not checked`);
  }

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => /continue/i.test(x.textContent));
    b?.click();
  });
  await sleep(1500);
  await page.screenshot({ path: `${shots}/phone-${target}-home.png` });

  const base = await page.evaluate(() => document.baseURI);
  console.log(`page ${base} (${target})`);

  const facts = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    const cs = getComputedStyle(document.body);
    return {
      meta,
      coarse: matchMedia('(pointer: coarse)').matches,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
      touchAction: getComputedStyle(document.documentElement).touchAction,
    };
  });
  note(/viewport-fit=cover/.test(facts.meta), `viewport meta has viewport-fit=cover (${facts.meta})`);
  note(facts.coarse, 'emulation reports (pointer: coarse), so the touch rules apply');
  note(facts.overflow <= 0, `no sideways scroll at ${PHONE.viewport.width}px (overflow ${facts.overflow}px)`);
  note(facts.touchAction === 'manipulation', `html touch-action is manipulation (${facts.touchAction})`);
  if (insetsApplied) {
    note(facts.padding[0] === `${INSETS.top}px` && facts.padding[2] === `${INSETS.bottom}px`,
      `body is padded by the simulated insets (${facts.padding.join(' ')})`);
  }

  // Editable fields: 16px or more, or iOS zooms on focus.
  const fields = await page.evaluate(() => [...document.querySelectorAll(
    'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])',
  )].filter(el => el.getClientRects().length > 0).map(el => ({
    tag: el.tagName.toLowerCase(),
    label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '',
    px: parseFloat(getComputedStyle(el).fontSize),
  })));
  console.log(`editable fields: ${JSON.stringify(fields)}`);
  note(fields.length > 0, 'found at least one editable field (the composer)');
  note(fields.every(f => f.px >= 16), `every editable field is at least 16px (${fields.map(f => f.px).join(', ')})`);

  // Small targets, for a human to judge; reported, not failed.
  const small = await page.evaluate(() => [...document.querySelectorAll(
    'button, a[href], [role=button], [role=menuitem], [role=tab], summary, input:not([type=hidden]), select, textarea',
  )].filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').map(el => {
    const r = el.getBoundingClientRect();
    return { label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(t => Math.min(t.w, t.h) < 44));
  console.log(`targets under 44px: ${small.length}`);
  for (const t of small.slice(0, 40)) console.log(`   ${String(t.w).padStart(3)}x${String(t.h).padEnd(3)} ${t.label}`);

  // Service worker and manifest, as the page's own origin serves them.
  const assets = await page.evaluate(async () => {
    const out = {};
    for (const name of ['sw.js', 'manifest.webmanifest']) {
      const res = await fetch(new URL(name, document.baseURI), { credentials: 'same-origin' });
      out[name] = { status: res.status, type: res.headers.get('content-type'), text: res.ok ? await res.text() : '' };
    }
    return out;
  });
  note(assets['sw.js'].status === 200 && /javascript/.test(assets['sw.js'].type ?? ''), `sw.js is served as JavaScript (${assets['sw.js'].status} ${assets['sw.js'].type})`);
  note(!/addEventListener\(\s*['"]fetch['"]/.test(assets['sw.js'].text), 'sw.js registers no fetch handler');
  note(assets['manifest.webmanifest'].status === 200, `manifest is served (${assets['manifest.webmanifest'].status})`);

  // The sidebar foot. On a phone the sidebar may start collapsed; open it if a toggle is found.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /expand|open sidebar|show sidebar|toggle sidebar/i.test(x.getAttribute('aria-label') || ''));
    b?.click();
  });
  await sleep(800);
  await page.screenshot({ path: `${shots}/phone-${target}-sidebar.png` });
  const foot = await page.evaluate(() => {
    const home = document.querySelector('a[aria-label="Vesta home"]');
    const bell = [...document.querySelectorAll('button')].find(x => /alerts/i.test(x.getAttribute('aria-label') || ''));
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    return { home: box(home), bell: bell ? { label: bell.getAttribute('aria-label'), pressed: bell.getAttribute('aria-pressed'), disabled: bell.disabled, box: box(bell) } : null };
  });
  console.log(`sidebar foot: ${JSON.stringify(foot)}`);
  if (foot.bell === null) console.log('note no alerts row: the Host runs without the push channel, or the sidebar is not open');
  else if (foot.home !== null) note(foot.bell.box[1] > foot.home[1], 'the alerts row sits below the home link (stacked, not side by side)');

  console.log(`page errors: ${JSON.stringify(errors)}`);
} finally {
  await browser.close();
}
if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s)`);
  process.exitCode = 1;
}
