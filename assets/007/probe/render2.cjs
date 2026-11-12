// Scene-cached renderer. Usage:
//   node render2.cjs <engine.html> <doc.json> <out.(mp4|mov)> [--alpha] [--workers 3] [--cache dir]
//   node render2.cjs <engine.html> <doc.json> <stillsDir> --stills 1.2,3.4
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; }, flag = k => a.includes(k);
const html = path.resolve(a[0]), doc = JSON.parse(fs.readFileSync(a[1], 'utf8')), out = path.resolve(a[2]);
const alpha = flag('--alpha'), fps = doc.fps || 30, workers = +(opt('--workers') || 3), cacheDir = path.resolve(opt('--cache') || 'cache');
const engineHash = crypto.createHash('sha1').update(fs.readFileSync(html)).digest('hex').slice(0, 10);
async function openPage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: doc.canvas.w, height: doc.canvas.h }, deviceScaleFactor: 1 });
  await page.goto('file://' + html);
  const info = await page.evaluate(d => window.mount(d), doc);
  await page.evaluate(() => window.prepare());
  return { browser, page, info };
}
(async () => {
  const T0 = Date.now();
  if (opt('--stills')) {
    const { browser, page } = await openPage(); fs.mkdirSync(out, { recursive: true });
    for (const t of opt('--stills').split(',').map(Number)) { await page.evaluate(t => window.render(t), t); await page.screenshot({ path: path.join(out, `t${t.toFixed(2)}.png`), omitBackground: alpha }); }
    await browser.close(); console.log(`stills_seconds=${((Date.now() - T0) / 1000).toFixed(1)}`); return;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  let t = 0; const ext = alpha ? 'mov' : 'mp4';
  const segs = doc.scenes.map(s => { const start = t; t += s.dur;
    const key = crypto.createHash('sha1').update(JSON.stringify({ s, start, theme: doc.theme, canvas: doc.canvas, fps, alpha, engineHash })).digest('hex').slice(0, 16);
    return { id: s.id, start, dur: s.dur, file: path.join(cacheDir, `${key}.${ext}`) }; });
  const todo = segs.filter(s => !fs.existsSync(s.file)); let frames = 0;
  async function worker() {
    if (!todo.length) return; const { browser, page } = await openPage();
    for (let seg; (seg = todo.shift());) {
      const enc = alpha ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-q:v', '11']
                        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-g', String(fps)];
      const tmp = seg.file + '.tmp.' + ext;
      const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', alpha ? 'png' : 'mjpeg', '-i', '-', ...enc, tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
      const n = Math.round(seg.dur * fps);
      for (let f = 0; f < n; f++) {
        await page.evaluate(t => window.render(t), seg.start + f / fps);
        const buf = await page.screenshot(alpha ? { type: 'png', omitBackground: true } : { type: 'jpeg', quality: 95 });
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      }
      ff.stdin.end(); await new Promise(r => ff.on('close', r)); fs.renameSync(tmp, seg.file); frames += n;
    }
    await browser.close();
  }
  const nTodo = todo.length;
  await Promise.all([...Array(Math.min(workers, Math.max(1, nTodo)))].map(worker));
  const list = out + '.txt'; fs.writeFileSync(list, segs.map(s => `file '${s.file}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(alpha ? [] : ['-movflags', '+faststart']), out]); fs.unlinkSync(list);
  console.log(JSON.stringify({ out: path.basename(out), scenes: segs.length, rendered: nTodo, cached: segs.length - nTodo, frames, seconds: +((Date.now() - T0) / 1000).toFixed(1) }));
})();
