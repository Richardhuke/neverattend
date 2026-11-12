// 签到页轮询：反复点大圆钮，直到「未发现考勤地点」消失（老师发布了考勤地点）
// 用法：node deploy/poll-sign.mjs [--interval 25] [--lat 30.3015] [--lng 120.0795] [--max 40]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ADB = process.env.NA_ADB || 'C:/Users/Richa/adbdl/platform-tools/adb.exe';
const SERIAL = process.env.NA_SERIAL || '10AG1H0QJE004HC';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const INTERVAL = Number(arg('--interval', 25));
const MAX = Number(arg('--max', 40));
const LAT = arg('--lat', '30.3015');
const LNG = arg('--lng', '120.0795');
const SHOT_DIR = arg('--shots', 'shots');

const sh = (...a) => execFileSync(ADB, ['-s', SERIAL, 'shell', ...a], { encoding: 'utf8', timeout: 25000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function texts () {
  const xml = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'uiautomator dump /dev/tty'], { encoding: 'utf8', maxBuffer: 8e6, timeout: 25000 });
  return [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.trim());
}

function tapText (label) {
  const xml = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'uiautomator dump /dev/tty'], { encoding: 'utf8', maxBuffer: 8e6, timeout: 25000 });
  const re = /<node[^>]*text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  for (const m of xml.matchAll(re)) {
    if (m[1].trim() === label) {
      const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
      const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
      sh('input', 'tap', String(cx), String(cy));
      return { cx, cy };
    }
  }
  return null;
}

function shot (name) {
  try {
    const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 20e6, timeout: 25000 });
    fs.writeFileSync(`${SHOT_DIR}/${name}`, buf);
  } catch (e) { /* ignore */ }
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

log(`poll start lat=${LAT} lng=${LNG} interval=${INTERVAL}s max=${MAX}`);
try { sh('cmd', 'location', 'providers', 'set-test-provider-location', 'gps', '--location', `${LAT},${LNG}`, '--accuracy', '6'); } catch {}

function appForeground () {
  try {
    const out = execFileSync(ADB, ['-s', SERIAL, 'shell', 'dumpsys', 'window'], { encoding: 'utf8', maxBuffer: 8e6, timeout: 20000 });
    const m = out.match(/mCurrentFocus=Window\{[^}]*\s([\w.]+)\//);
    return m ? m[1] : '';
  } catch { return ''; }
}

let tries = 0;
let lastState = '';
while (tries < MAX) {
  tries += 1;
  const pkg = appForeground();
  if (!/net\.crigh\.mysport/.test(pkg)) {
    if (lastState !== 'bg') { log(`App 不在前台（当前 ${pkg || '未知'}），暂停点击，等它回到前台`); lastState = 'bg'; }
    await sleep(INTERVAL * 1000);
    continue;
  }
  sh('input', 'tap', '631', '2181');
  await sleep(1600);
  const t = texts().join(' | ');
  if (/未发现考勤地点/.test(t)) {
    if (lastState !== 'noloc') { log('未发现考勤地点（老师还没发布签到地点），继续等'); lastState = 'noloc'; }
    tapText('确定');
    await sleep(400);
  } else if (/签到成功|签到完成|已签到/.test(t)) {
    log('★ 签到成功：', t);
    shot('poll-success.png');
    process.exit(0);
  } else if (/不在|范围|距离|米|定位/.test(t)) {
    log('★ 有反馈：', t);
    shot(`poll-feedback-${tries}.png`);
    process.exit(2);
  } else if (/未签到/.test(t)) {
    if (lastState !== 'silent') { log('点了没明显反馈（弹窗可能一闪而过）'); lastState = 'silent'; }
  } else {
    log('页面变化：', t.slice(0, 120));
    lastState = 'changed';
  }
  await sleep(INTERVAL * 1000);
}
log('达到上限，退出');
process.exit(1);
