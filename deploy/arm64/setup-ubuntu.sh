#!/usr/bin/env bash
# 在 ARM64 Ubuntu / Debian（阿里云倚天 710、树莓派 4/5、Oracle Ampere、AWS Graviton 均可）上一键备好签名环境。
# 用法：bash setup-ubuntu.sh [/opt/armsign]
set -euo pipefail

DEST="${1:-/opt/armsign}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== 0/4 架构检查 =="
ARCH="$(uname -m)"
echo "[..] uname -m = $ARCH"
case "$ARCH" in
  aarch64|arm64) echo "[OK] 是 ARM64" ;;
  *) echo "[FAIL] 这台不是 ARM64（$ARCH）。本方案必须在真 ARM 上跑，x64 上 dlopen 会直接失败。"; exit 1 ;;
esac

echo "== 1/4 系统依赖 =="
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  # 只要有 python3 + libc 即可；额外装个 file/xxd 便于排查
  sudo apt-get install -y python3 ca-certificates file xxd
else
  echo "[WARN] 没有 apt-get，跳过依赖安装（确保有 python3）"
fi
python3 -V

echo "== 2/4 落地文件 =="
sudo mkdir -p "$DEST/so"
sudo cp -f "$HERE/arm_sign.py"               "$DEST/arm_sign.py"
sudo cp -f "$HERE/so/"*.so                   "$DEST/so/" 2>/dev/null || true
sudo cp -f "$HERE/so/cert.der"               "$DEST/so/cert.der" 2>/dev/null || true
sudo chmod 755 "$DEST/arm_sign.py"
echo "[OK] 目录：$DEST"
ls -l "$DEST" "$DEST/so"

echo "== 3/4 证书指纹自检（必须等于 1f240fea3029dbb956dd29786dd021302d395649）=="
python3 - "$DEST/so/cert.der" <<'PY'
import hashlib, sys, os
p = sys.argv[1]
if not os.path.exists(p):
    print('[FAIL] 缺 cert.der'); sys.exit(1)
h = hashlib.sha1(open(p,'rb').read()).hexdigest()
print('[..] sha1(cert.der) =', h)
print('[OK] 与预期一致' if h == '1f240fea3029dbb956dd29786dd021302d395649' else '[WARN] 与预期不一致，签名会被服务端拒绝')
PY

echo "== 4/4 冒烟测试 =="
cd "$DEST"
python3 arm_sign.py || true

echo
echo "==== 完成 ===="
echo "以后调用： cd $DEST && python3 arm_sign.py '<path>' '<query>' --json"
echo "接入后端： 在 Node 里 execFile 上面这行即可（见 deploy/arm64/README.md）"
