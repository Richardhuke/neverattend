#!/data/data/com.termux/files/usr/bin/bash
# 手机 Termux（ARM64 Android）上一键备好签名环境。零成本、零服务器。
# 前提：手机是 arm64（`uname -m` = aarch64），Termux 来自 F-Droid 或 GitHub 版（Play 版过旧）。
# 用法：bash setup-termux.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/armsign"

echo "== 0/4 架构检查 =="
ARCH="$(uname -m)"
echo "[..] uname -m = $ARCH"
case "$ARCH" in
  aarch64|arm64) echo "[OK] 是 ARM64" ;;
  *) echo "[FAIL] Termux 跑在 $ARCH 上，无法加载 arm64-v8a 的 .so"; exit 1 ;;
esac

echo "== 1/4 Termux 依赖 =="
pkg update -y
pkg install -y python
python -V

echo "== 2/4 落地文件 =="
mkdir -p "$DEST/so"
cp -f "$HERE/arm_sign.py" "$DEST/arm_sign.py"
cp -f "$HERE/so/"*.so     "$DEST/so/" 2>/dev/null || true
cp -f "$HERE/so/cert.der" "$DEST/so/cert.der" 2>/dev/null || true
chmod 755 "$DEST/arm_sign.py"
ls -l "$DEST" "$DEST/so"

echo "== 3/4 证书指纹自检 =="
python - "$DEST/so/cert.der" <<'PY'
import hashlib, sys, os
p = sys.argv[1]
if not os.path.exists(p):
    print('[FAIL] 缺 cert.der'); sys.exit(1)
h = hashlib.sha1(open(p,'rb').read()).hexdigest()
print('[..] sha1(cert.der) =', h)
print('[OK] 与预期一致' if h == '1f240fea3029dbb956dd29786dd021302d395649' else '[WARN] 与预期不一致')
PY

echo "== 4/4 冒烟测试 =="
cd "$DEST"
python arm_sign.py || true

echo
echo "==== 完成 ===="
echo "调用： cd ~/armsign && python arm_sign.py '<path>' '<query>' --json"
echo "自启（可选）： crontab -e 加一行 @reboot cd ~/armsign && 起你们自己的桥接脚本"
