import { execFileSync } from 'node:child_process';
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
const sleep0 = async () => {};
const pts = JSON.parse(process.argv[2]);
for (const [lat, lng] of pts) {
  sh('cmd', 'location', 'providers', 'set-test-provider-location', 'gps', '--location', `${lat},${lng}`, '--accuracy', '6');
  await sleep(1800);
  sh('input', 'tap', '631', '2181');
  await sleep(2000);
  const t = texts();
  const bad = /不在考勤范围内/.test(t);
  const ok = /签到成功|签到完成|已签到/.test(t);
  const none = /未发现考勤地点/.test(t);
  console.log(`${lat},${lng} -> ${ok ? 'SUCCESS' : bad ? 'out-of-range' : none ? 'no-venue' : 'unknown: ' + t.slice(0, 120)}`);
  if (bad || none) { sh('input', 'tap', '349', '1745'); await sleep(700); }
  if (ok) break;
}
await sleep0();
