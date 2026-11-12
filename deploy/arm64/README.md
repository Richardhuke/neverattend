# ARM64 签名机（彻底不用手机的那条路）

目标：在一台真 ARM64 Linux 上加载 `libAMapSDK_Location_v6_6_0.so`，直接调
`net.crigh.api.encrypt.ChingoEncrypt.cgapiEnrypt(path, query)`，拿到浙大体艺 App
请求头里的签名串，然后后端就能自己发 `api/l/v6/attendance/*` —— 网站上一个按钮，
背后不需要任何手机。

## 为什么必须是真 ARM

`.so` 是 `aarch64` 机器码，且内部用了 `ptrace`（反调试）、`dl_iterate_phdr`、
locale 家族和大量不透明谓词。Windows x64 上用 Unicorn 模拟能跑到「密钥派生成功」，
但会在签名主函数的分支判定处偏离真实执行流（详见 `tools/emu_sign.py` 的调试记录：
`0x1003e7dc` 处 `w8==w9==0xadddd1d3` → 走错误出口）。真机上这些前置条件天然成立。

## 一个反直觉的事实：不需要编译器

不必写 C，也不必装 JNI 头。Python 的 `ctypes` 直接 `dlopen`，再用
`CFUNCTYPE` 手搓一张 240 项的函数指针表当 `JNIEnv*` 传进去就行——
`tools/arm_sign.py` 已经写好，纯标准库。

## 三条落地路径，按成本排序

| 路径 | 成本 | 适用 |
|---|---|---|
| **手机 Termux** | 0 元 | 手头这台安卓就是 arm64，装个 Termux 就能跑 |
| **阿里云倚天 710** | 按量 ~0.3 元/时 | 要 7×24 常驻、要公网 IP |
| 树莓派 / Oracle Ampere / Graviton | 已有设备 | 同上 |

### A. Termux（最快，5 分钟）

1. 手机装 Termux（**F-Droid 或 GitHub Releases 版**，Play 商店版太旧）。
2. 把 `arm-sign-arm64.tar.gz` 传到手机（微信/QQ 传到 Download 目录即可）。
3. 在 Termux 里：
   ```bash
   pkg install -y tar
   mkdir -p ~/armsign && tar -xzf ~/storage/downloads/arm-sign-arm64.tar.gz -C ~/armsign
   bash ~/armsign/setup-termux.sh
   ```
4. 看到 `sha1(cert.der) = 1f240fea…5649` 和一行 `output = ...` 就成了。

### B. 阿里云倚天 710（推荐常驻）

1. 控制台买「通用型 g8y / 计算型 c8y」，**架构选 ARM64**，镜像 Ubuntu 22.04，2C4G 足够。
2. 安全组只放你要用的端口（签名服务走内网/隧道，不要暴露 8000）。
3. 上传并安装：
   ```bash
   scp arm-sign-arm64.tar.gz root@<IP>:/root/
   ssh root@<IP> 'mkdir -p /opt/armsign && tar -xzf /root/arm-sign-arm64.tar.gz -C /opt/armsign && bash /opt/armsign/setup-ubuntu.sh /opt/armsign'
   ```

### C. 树莓派

同 B，把 `setup-ubuntu.sh` 直接跑，`aarch64` 系统（Raspberry Pi OS 64-bit / Ubuntu Server arm64）。

## 验证签名对不对（关键一步）

单跑出字符串**不代表**服务端认。三步验证，从便宜到贵：

```bash
# 1) 本地：签名串应当是可打印 ASCII，长度几十到几百
python3 /opt/armsign/arm_sign.py '/api/l/v6/attendance/attendancelist' 'timestamp=1700000000&uid=3260103483'

# 2) 打真接口：拿 JWT（neverattend/jwt.txt）+ 签名，看是否还回 2001「登录过期」
#    这里的 header 名和拼串规则用 App 实际抓到的为准
curl -s -X POST 'http://www.tyys.zju.edu.cn/cgapp-server/api/l/v6/attendance/attendancelist' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'cgAuthorization: <jwt>' \
  -H 'sign: <arm_sign 输出>' \
  --data 'timestamp=1700000000&uid=3260103483'

# 3) 对照：手机上抓一次 App 的真实请求（adb + mitm），把 header 逐字段比对
```

只要第 2 步从 `{"code":2001}` 变成业务数据，签名就通了。

## 接进 NeverAttend 后端

`neverattend/backend/src/services/` 里加一个薄封装，把签名机当外部命令调：

```js
// neverattend/backend/src/services/signer.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const CMD = process.env.ARM_SIGN_CMD; // 例：/opt/armsign/arm_sign.py
export async function signPathQuery(path, query) {
  if (!CMD) throw new Error('ARM_SIGN_CMD 未配置');
  const { stdout } = await run('python3', [CMD, path, query, '--json'], { timeout: 10000 });
  const out = JSON.parse(stdout);
  if (!out.ok) throw new Error(out.error || 'sign failed');
  return out.result;
}
```

签名机在内网时，也可以让它起一个 20 行的 HTTP 服务（`POST /sign {path,query}`），
后端用 `fetch` 调，省掉进程开销。

## 文件清单

| 文件 | 作用 |
|---|---|
| `tools/arm_sign.py` | 纯 ctypes 的 JNI 宿主，输出签名串，支持 `--json` |
| `deploy/arm64/setup-ubuntu.sh` | ARM64 Ubuntu 一键装（架构检查 + 指纹自检 + 冒烟） |
| `deploy/arm64/setup-termux.sh` | Termux 一键装 |
| `deploy/arm64/pack.sh` | 打 `arm-sign-arm64.tar.gz`（含 `.so` 与 `cert.der`） |
| `so/libAMapSDK_Location_v6_6_0_arm64-v8a.so` | 签名实现本体（1 161 192 B） |
| `so/cert.der` | APK 签名证书 DER（709 B），`sha1 = 1f240fea…5649` |

## 已知风险

- `cert.der` 必须与线上 App 的签名证书**完全一致**，否则服务端校验不过（脚本会打印指纹自检）。
- 签名里的 `timestamp` 通常有有效期窗口，别缓存太久。
- 若真机上仍返回 `ERROR CODE：`，先确认 `.so` 是从**当前线上版本**的 APK 里取的（`apk2/zyty.apk`），
  再确认 `cert.der` 来自同一个 APK 的 `META-INF/*.RSA`。
