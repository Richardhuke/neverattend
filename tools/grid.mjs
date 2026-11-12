import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const ADB = 'C:/Users/Richa/adbdl/platform-tools/adb.exe';
const S = '10AG1H0QJE004HC';
const sh = (...a) => execFileSync(ADB, ['-s', S, 'shell', ...a], { encoding: 'utf8', maxBuffer: 8e6, timeout: 25000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function texts () {
  try {
    const x = execFileSync(ADB, ['-s', S, 'exec-out', 'uiautomator dump /dev/tty'], { encoding: 'utf8', maxBuffer: 8e6, timeout: 20000 });
    return [...x.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(' | ');
  } catch { return ''; }
}
function shot (name) {
  try {
    const buf = execFileSync(ADB, ['-s', S, 'exec-out', 'screencap -p'], { maxBuffer: 3e8, timeout: 30000 });
    require('node:fs').writeFileSync(`shots/${name}.png`, buf);
  } catch {}
}
const lat0 = Number(process.argv[2]);
const lng0 = Number(process.argv[3]);
const rad = Number(process.argv[4] || 4);
const step = Number(process.argv[5] || 0.0012);
let found = false;
for (let i = -rad; i <= rad && !found; i++) {
  for (let j = -rad; j <= rad && !found; j++) {
    const lat = +(lat0 + i * step).toFixed(4);
    const lng = +(lng0 + j * step).toFixed(4);
    sh('cmd', 'location', 'providers', 'set-test-provider-location', 'gps', '--location', `${lat},${lng}`, '--accuracy', '6');
    await sleep(1200);
    sh('input', 'tap', '631', '2181');
    let result = 'timeout';
    for (let k = 0; k < 12; k++) {
      await sleep(600);
      const t = texts();
      if (/签到成功|签到完成|已签到/.test(t)) { result = 'SUCCESS'; break; }
      if (/不在考勤范围内/.test(t)) { result = 'out'; break; }
      if (/未发现考勤地点/.test(t)) { result = 'novenue'; break; }
    }
    console.log(`${new Date().toISOString().slice(11, 19)} ${lat},${lng} -> ${result}`);
    if (result === 'out' || result === 'novenue') { sh('input', 'tap', '349', '1745'); await sleep(600); }
    if (result === 'SUCCESS') { shot(`SUCCESS-${lat}-${lng}`); found = true; }
  }
}
console.log(found ? 'FOUND' : 'NOT FOUND');
