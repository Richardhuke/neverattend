#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arm_sign.py — 在真实 ARM64 Linux（倚天 710 / 树莓派 / 手机 Termux）上直接驱动
libAMapSDK_Location_v6_6_0.so 的 ChingoEncrypt.cgapiEnrypt，复刻浙大体艺 App 的请求签名。

不需要 JDK、不需要 gcc、不需要 JNI 头文件：用纯 ctypes 手搓一张 JNIEnv 函数表。

用法：
    python3 tools/arm_sign.py                      # 用内置样例跑一次
    python3 tools/arm_sign.py "/api/l/v6/attendance/attendancelist" "timestamp=1700000000&uid=3260103483"
    python3 tools/arm_sign.py --json               # 输出 JSON，方便 Node 调用

依赖文件（与本脚本同级或 SO_DIR 指定）：
    so/libAMapSDK_Location_v6_6_0_arm64-v8a.so     # 从 apk2/zyty.apk 的 lib/arm64-v8a/ 解出
    so/cert.der                                    # 从 apk2/zyty.apk 的 META-INF/*.RSA 里取证书 DER
"""

import ctypes
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SO_CANDIDATES = [
    os.path.join(ROOT, 'so', 'libAMapSDK_Location_v6_6_0_arm64-v8a.so'),
    os.path.join(HERE, 'libAMapSDK_Location_v6_6_0_arm64-v8a.so'),
    './libAMapSDK_Location_v6_6_0_arm64-v8a.so',
]
CERT_CANDIDATES = [
    os.path.join(ROOT, 'so', 'cert.der'),
    os.path.join(HERE, 'cert.der'),
    './cert.der',
]
SYMBOL = 'Java_net_crigh_api_encrypt_ChingoEncrypt_cgapiEnrypt'

# JNI 函数表下标（与 jni.h 的 JNINativeInterface 顺序一致）
IDX_GET_VERSION = 4
IDX_FIND_CLASS = 6
IDX_NEW_GLOBAL_REF = 20
IDX_DELETE_GLOBAL_REF = 21
IDX_DELETE_LOCAL_REF = 23
IDX_NEW_OBJECT = 28
IDX_NEW_OBJECT_V = 29
IDX_GET_OBJECT_CLASS = 31
IDX_GET_METHOD_ID = 33
IDX_CALL_OBJECT_METHOD = 34
IDX_CALL_OBJECT_METHOD_V = 35
IDX_GET_STATIC_METHOD_ID = 113
IDX_CALL_STATIC_OBJECT_METHOD = 114
IDX_CALL_STATIC_OBJECT_METHOD_V = 115
IDX_NEW_STRING_UTF = 167
IDX_GET_STRING_UTF_CHARS = 169
IDX_RELEASE_STRING_UTF_CHARS = 170
IDX_GET_ARRAY_LENGTH = 171
IDX_NEW_BYTE_ARRAY = 176
IDX_GET_BYTE_ARRAY_ELEMENTS = 184
IDX_RELEASE_BYTE_ARRAY_ELEMENTS = 185
IDX_GET_BYTE_ARRAY_REGION = 200
IDX_EXCEPTION_CHECK = 228
IDX_EXCEPTION_OCCURRED = 229
IDX_EXCEPTION_CLEAR = 230
IDX_GET_JAVA_VM = 219

TABLE_SIZE = 240

# 一个足够宽的通用签名：AArch64 前 8 个参数走 x0..x7，多传几个无妨，
# 被调方不用的寄存器会被忽略；返回值统一用指针宽度，小整数直接塞进去即可。
JNI_FN = ctypes.CFUNCTYPE(ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p)


class Refs:
    """假 Java 对象池：把 id(obj) 当 jstring/jobject/jarray 指针用。"""

    def __init__(self):
        self.pool = {}
        self.seq = 0x1000

    def new(self, kind, data=None):
        self.seq += 1
        h = self.seq
        self.pool[h] = {'kind': kind, 'data': data}
        return h

    def get(self, h):
        return self.pool.get(h)

    def free(self, h):
        self.pool.pop(h, None)


class ArmSigner:
    def __init__(self, so_path, cert_path, verbose=True):
        self.verbose = verbose
        self.cert = open(cert_path, 'rb').read()
        self.refs = Refs()
        self.log = []
        self._keep = []

        self.lib = ctypes.CDLL(so_path, mode=ctypes.RTLD_GLOBAL)
        fn = getattr(self.lib, SYMBOL)
        fn.restype = ctypes.c_void_p
        fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        self.fn = fn

        self._build_env()

    # ---------- JNIEnv 表 ----------
    def _build_env(self):
        table = (ctypes.c_void_p * TABLE_SIZE)()
        for idx in range(TABLE_SIZE):
            cb = JNI_FN(self._make_handler(idx))
            self._keep.append(cb)
            table[idx] = ctypes.cast(cb, ctypes.c_void_p).value
        # JNIEnv* 指向「函数指针数组」本身
        self._table = table
        self.env = ctypes.cast(ctypes.byref(table), ctypes.c_void_p).value

    def _make_handler(self, idx):
        def handler(env, a1, a2, a3, a4, a5, a6, a7):
            try:
                return self._dispatch(idx, a1, a2, a3, a4)
            except Exception as e:  # 绝不让异常穿回 C 栈
                self._note('!! handler %d raised %r' % (idx, e))
                return 0
        return handler

    def _note(self, s):
        self.log.append(s)
        if self.verbose:
            sys.stderr.write(s + '\n')

    def _s(self, h):
        r = self.refs.get(h)
        if not r:
            return None
        return r.get('data')

    # ---------- 分发 ----------
    def _dispatch(self, idx, a1, a2, a3, a4):
        if idx == IDX_GET_VERSION:
            return 0x00010006

        if idx == IDX_FIND_CLASS:
            name = self._s(a1)
            self._note('[jni] %3d FindClass(%s)' % (idx, name))
            return self.refs.new('class', name)

        if idx in (IDX_NEW_GLOBAL_REF,):
            return a1
        if idx in (IDX_DELETE_GLOBAL_REF,):
            return 0
        if idx == IDX_DELETE_LOCAL_REF:
            self.refs.free(a1)
            return 0

        if idx in (IDX_NEW_OBJECT, IDX_NEW_OBJECT_V):
            clazz = self._s(a1)
            self._note('[jni] %3d NewObject(%s)' % (idx, clazz))
            return self.refs.new('obj', clazz)

        if idx == IDX_GET_OBJECT_CLASS:
            return self.refs.new('class', self._s(a1) or 'unknown')

        if idx in (IDX_GET_METHOD_ID, IDX_GET_STATIC_METHOD_ID):
            name = self._s(a2)
            sig = self._s(a3)
            self._note('[jni] %3d GetMethodID(%s %s)' % (idx, name, sig))
            return self.refs.new('method', name)

        if idx in (IDX_CALL_OBJECT_METHOD, IDX_CALL_OBJECT_METHOD_V,
                   IDX_CALL_STATIC_OBJECT_METHOD, IDX_CALL_STATIC_OBJECT_METHOD_V):
            return self._call(a1, a2, a3)

        if idx == IDX_NEW_STRING_UTF:
            s = self._s(a1)
            if s is None:
                s = '<null>'
            self._note('[jni] %3d NewStringUTF(%r)' % (idx, s))
            return self.refs.new('str', s)

        if idx == IDX_GET_STRING_UTF_CHARS:
            s = self._s(a1) or ''
            buf = ctypes.create_string_buffer(s.encode('utf-8'))
            self._keep.append(buf)
            if a2:
                ctypes.cast(a2, ctypes.POINTER(ctypes.c_ubyte))[0] = 0
            return ctypes.cast(buf, ctypes.c_void_p).value

        if idx == IDX_RELEASE_STRING_UTF_CHARS:
            return 0

        if idx == IDX_GET_ARRAY_LENGTH:
            data = self._s(a1) or b''
            self._note('[jni] %3d arraylen -> %d' % (idx, len(data)))
            return len(data)

        if idx == IDX_NEW_BYTE_ARRAY:
            return self.refs.new('bytes', bytearray(int(a1)))

        if idx == IDX_GET_BYTE_ARRAY_ELEMENTS:
            data = self._s(a1) or b''
            self._note('[jni] %3d GetByteArrayElements(%db)' % (idx, len(data)))
            buf = ctypes.create_string_buffer(bytes(data), max(len(data), 1))
            self._keep.append(buf)
            if a3:
                ctypes.cast(a3, ctypes.POINTER(ctypes.c_ubyte))[0] = 0
            return ctypes.cast(buf, ctypes.c_void_p).value

        if idx == IDX_RELEASE_BYTE_ARRAY_ELEMENTS:
            return 0

        if idx == IDX_GET_BYTE_ARRAY_REGION:
            data = self._s(a1) or b''
            start, ln = int(a2), int(a3)
            if a4 and ln > 0:
                ctypes.memmove(a4, bytes(data[start:start + ln]), ln)
            return 0

        if idx in (IDX_EXCEPTION_CHECK,):
            return 0
        if idx in (IDX_EXCEPTION_OCCURRED,):
            return 0
        if idx in (IDX_EXCEPTION_CLEAR,):
            return 0
        if idx == IDX_GET_JAVA_VM:
            return 0

        self._note('[jni] %3d unhandled' % idx)
        return 0

    # ---------- Java 方法语义 ----------
    def _call(self, obj_h, mid_h, va):
        name = self._s(mid_h)
        o = self.refs.get(obj_h) or {}

        if name == 'getPackageManager':
            return self.refs.new('obj', 'PackageManager')
        if name == 'getPackageName':
            return self.refs.new('str', 'net.crigh.mysport')
        if name == 'getPackageInfo':
            return self.refs.new('obj', 'PackageInfo')
        if name == 'signatures':
            return self.refs.new('bytes', [self.refs.new('obj', 'Signature')])
        if name == 'toByteArray':
            self._note('[jni]   toByteArray -> cert.der %db' % len(self.cert))
            return self.refs.new('bytes', bytearray(self.cert))
        if name == 'generateCertificate':
            return self.refs.new('obj', 'Certificate')
        if name == 'getEncoded':
            return self.refs.new('bytes', bytearray(self.cert))
        if name == 'getInstance':
            return self.refs.new('obj', 'MessageDigest:SHA1')
        if name == 'digest':
            arg = self._s(va) or b''
            raw = bytes(arg) if isinstance(arg, (bytes, bytearray)) else b''
            if not raw:
                raw = self.cert
            d = hashlib.sha1(raw).digest()
            self._note('[jni]   digest(%db of %r) -> %s' % (len(raw), raw[:8], d.hex()))
            return self.refs.new('bytes', bytearray(d))
        if name == '<init>':
            return self.refs.new('obj', o.get('data'))

        self._note('[jni]   call %s (unhandled)' % name)
        return 0

    # ---------- 调用 ----------
    def sign(self, path, query):
        a = self.refs.new('str', path)
        b = self.refs.new('str', query)
        r = self.fn(self.env, 0, a, b)
        out = self._s(r)
        if isinstance(out, str):
            out = out.encode('utf-8', 'replace')
        return out


def find(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


def main():
    args = [a for a in sys.argv[1:]]
    as_json = '--json' in args
    if as_json:
        args.remove('--json')

    so = find(SO_CANDIDATES)
    cert = find(CERT_CANDIDATES)
    if not so:
        print(json.dumps({'ok': False, 'error': 'so not found', 'tried': SO_CANDIDATES}))
        return 2
    if not cert:
        print(json.dumps({'ok': False, 'error': 'cert.der not found', 'tried': CERT_CANDIDATES}))
        return 2

    path = args[0] if len(args) > 0 else '/api/l/v6/attendance/attendancelist'
    query = args[1] if len(args) > 1 else 'timestamp=1700000000&uid=3260103483'

    try:
        s = ArmSigner(so, cert, verbose=not as_json)
        out = s.sign(path, query)
    except OSError as e:
        msg = ('cannot load .so: %s | uname -m=%s | 必须跑在 ARM64 Linux 上（Termux / 倚天 710 / 树莓派），'
               'x64 上 dlopen 一定失败' % (e, os.uname().machine if hasattr(os, 'uname') else 'win'))
        print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False) if as_json else '[FAIL] ' + msg)
        return 3

    if as_json:
        print(json.dumps({'ok': True, 'path': path, 'query': query,
                          'result': out.decode('utf-8', 'replace') if isinstance(out, bytes) else out,
                          'cert_sha1': hashlib.sha1(open(cert, 'rb').read()).hexdigest()}, ensure_ascii=False))
    else:
        print('cert sha1 =', hashlib.sha1(open(cert, 'rb').read()).hexdigest())
        print('output    =', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
