#!/usr/bin/env bash
# 把「一台 ARM64 机器需要的最小文件集」打成一个包，直接 scp 上去解压即用。
# 产物：deploy/arm64/arm-sign-arm64.tar.gz（约 1.2 MB）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 资产目录（含 tools/arm_sign.py 与 so/cert.der）：
#   1) 环境变量 SIGN_ROOT 指定的目录
#   2) 从脚本所在目录逐级向上找，命中 so/cert.der 即为根
ROOT="${SIGN_ROOT:-}"
if [ -z "$ROOT" ]; then
  d="$HERE"
  while [ "$d" != "/" ]; do
    if [ -f "$d/so/cert.der" ]; then ROOT="$d"; break; fi
    d="$(dirname "$d")"
  done
fi
if [ -z "$ROOT" ]; then
  echo "[FAIL] 找不到资产目录（含 so/cert.der）。用 SIGN_ROOT=<dir> 指定。"
  exit 1
fi
echo "[..] 资产根目录：$ROOT"
OUT="$HERE/arm-sign-arm64.tar.gz"
STAGE="$(mktemp -d)"

mkdir -p "$STAGE/so"
cp "$ROOT/tools/arm_sign.py" "$STAGE/arm_sign.py"
cp "$HERE/setup-ubuntu.sh" "$STAGE/setup-ubuntu.sh"
cp "$HERE/setup-termux.sh" "$STAGE/setup-termux.sh"
cp "$HERE/README.md" "$STAGE/README.md" 2>/dev/null || true
cp "$HERE/serve.py" "$STAGE/serve.py" 2>/dev/null || true

for f in "$ROOT/so/libAMapSDK_Location_v6_6_0_arm64-v8a.so" "$ROOT/so/cert.der"; do
  if [ -f "$f" ]; then
    cp "$f" "$STAGE/so/"
    echo "[OK] $(basename "$f")  $(wc -c < "$f") bytes"
  else
    echo "[FAIL] 缺文件：$f"
    exit 1
  fi
done

tar -czf "$OUT" -C "$STAGE" .
rm -rf "$STAGE"
echo "[OK] 打包完成：$OUT  $(wc -c < "$OUT") bytes"
echo
echo "上传并在服务器上执行："
echo "  scp $OUT root@<ARM_HOST>:/root/"
echo "  ssh root@<ARM_HOST> 'mkdir -p /opt/armsign && tar -xzf /root/arm-sign-arm64.tar.gz -C /opt/armsign && bash /opt/armsign/setup-ubuntu.sh /opt/armsign'"
