#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — 把签名能力包成一个本机 HTTP 服务，Node 后端 fetch 一下就能用。
（.so 只 dlopen 一次，常驻内存，比每次起进程快得多）

启动：
    python3 serve.py                 # 监听 127.0.0.1:8791
    python3 serve.py 0.0.0.0 8791    # 需要别的机器调时（务必配 AUTH_TOKEN）

调用：
    curl -s -X POST http://127.0.0.1:8791/sign \
         -H 'content-type: application/json' \
         -H "authorization: Bearer $ARM_SIGN_TOKEN" \
         -d '{"path":"/api/l/v6/attendance/attendancelist","query":"timestamp=1700000000&uid=3260103483"}'
    -> {"ok":true,"result":"..."}

环境变量：
    ARM_SIGN_TOKEN   设了就要求请求头 authorization: Bearer <token>
    ARM_SIGN_SO      .so 路径（默认同目录 so/libAMapSDK_Location_v6_6_0_arm64-v8a.so）
    ARM_SIGN_CERT    证书路径（默认同目录 so/cert.der）
"""

import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from arm_sign import ArmSigner, find, SO_CANDIDATES, CERT_CANDIDATES  # noqa: E402

TOKEN = os.environ.get('ARM_SIGN_TOKEN', '').strip()

def _resolve():
    so = os.environ.get('ARM_SIGN_SO') or find(SO_CANDIDATES) or find([os.path.join(HERE, 'so', 'libAMapSDK_Location_v6_6_0_arm64-v8a.so')])
    cert = os.environ.get('ARM_SIGN_CERT') or find(CERT_CANDIDATES) or find([os.path.join(HERE, 'so', 'cert.der')])
    if not so or not os.path.exists(so):
        raise SystemExit('[FAIL] 找不到 .so：%r' % so)
    if not cert or not os.path.exists(cert):
        raise SystemExit('[FAIL] 找不到 cert.der：%r' % cert)
    return so, cert

SO, CERT = _resolve()
print('[..] so   =', SO)
print('[..] cert =', CERT, hashlib.sha1(open(CERT, 'rb').read()).hexdigest())
SIGNER = ArmSigner(SO, CERT, verbose=False)
print('[OK] JNIEnv 已就绪，等待请求')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'armsign/1.0'

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        if not TOKEN:
            return True
        hdr = self.headers.get('authorization', '')
        return hdr == 'Bearer ' + TOKEN

    def do_GET(self):
        if self.path.startswith('/health'):
            self._json(200, {'ok': True, 'cert_sha1': hashlib.sha1(open(CERT, 'rb').read()).hexdigest()})
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/sign'):
            return self._json(404, {'ok': False, 'error': 'not found'})
        if not self._auth_ok():
            return self._json(401, {'ok': False, 'error': 'unauthorized'})
        try:
            n = int(self.headers.get('content-length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
            path = req.get('path') or ''
            query = req.get('query') or ''
            out = SIGNER.sign(path, query)
            if isinstance(out, bytes):
                out = out.decode('utf-8', 'replace')
            self._json(200, {'ok': True, 'result': out})
        except Exception as e:
            self._json(500, {'ok': False, 'error': repr(e)})

    def log_message(self, fmt, *a):
        sys.stderr.write('[http] ' + (fmt % a) + '\n')


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8791
    if host not in ('127.0.0.1', 'localhost') and not TOKEN:
        print('[WARN] 监听在 %s 但没设 ARM_SIGN_TOKEN，任何能连上的人都能让这台机器签名' % host)
    srv = ThreadingHTTPServer((host, port), Handler)
    print('[..] listen http://%s:%d' % (host, port))
    srv.serve_forever()


if __name__ == '__main__':
    main()
