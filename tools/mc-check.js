const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const TARGET = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
const OUT = path.join(__dirname, 'mc-check.out.txt');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));

  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const info = await page.evaluate(async () => {
    document.getElementById('modelsWin').classList.remove('hidden');
    await renderModelsConsole();
    const eng = document.getElementById('mcEng');
    const pick = () => ({
      engText: eng.innerText.replace(/\s+/g, ' ').trim(),
      engBtns: Array.from(eng.querySelectorAll('button')).map(b => b.textContent + (b.disabled ? '(禁用)' : '')),
      hasProgressBar: !!eng.querySelector('.mc-eng-progress'),
      tabs: Array.from(document.querySelectorAll('#mcKinds [data-mc-scope]')).map(b => b.textContent + (b.classList.contains('active') ? '*' : '')),
      scope: mcGetScope('llm'),
      rows: Array.from(document.querySelectorAll('#mcKinds .mc-prov-name')).map(e => e.textContent),
      sections: Array.from(document.querySelectorAll('#mcKinds .mc-sec-name')).map(e => e.textContent)
    });
    const local = pick();
    // 切到本地
    const localBtn = document.querySelector('#mcKinds [data-mc-scope="local"]');
    if (localBtn) localBtn.click();
    await new Promise(r => setTimeout(r, 120));
    const llmLocal = pick();
    // 再切回云端
    const cloudBtn = document.querySelector('#mcKinds [data-mc-scope="cloud"]');
    if (cloudBtn) cloudBtn.click();
    await new Promise(r => setTimeout(r, 120));
    const cloud = pick();
    return { local, llmLocal, cloud, engState: mcEngState(), desk: !!mcDesk() };
  });

  fs.writeFileSync(OUT, JSON.stringify({ info, errors }, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => {
  fs.writeFileSync(OUT, 'FAILED ' + String((e && e.stack) || e));
  process.exit(2);
});