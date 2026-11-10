# 浙大体艺 v6 接口（`/api/**`）排查记录

> 结论先说：**v6 走不通**，签名在 native 库里，Windows 无法复刻。
> 身体素质课的签到/签退只能由手机端完成（`deploy/adb-ns.mjs` 或 `deploy/autojs-ns.js`）。

## 1. 实际探测结果（2026-11-10）

基址 `http://www.tyys.zju.edu.cn/cgapp-server`。

| 请求 | 结果 |
| --- | --- |
| `GET api/l/v6/currentTimeMillis` 无头 | `{"code":2002,"message":"非法的请求参数"}` |
| 同上 + `schoolid/client/timestamp/imei/UA` 任意组合 | 仍 `2002`（这些不是它要的） |
| 同上 + `Authorization: <jwt>` 或 `cgAuthorization: <jwt>` | `{"code":2001,"message":"登录过期，请重新登录"}` |
| `POST api/f/v6/login` 空/任意表单/JSON | `{"code":400,"message":"参数错误"}` |
| 同上 + `sign: <46 个 0>` + `timestamp` | `{"code":401,"message":"Unauthorized"}` |

解读：

- `2002` = 缺鉴权头；`2001` = 认出了 JWT 但会话不在 v6 会话表里。
- `/app/cas/appLogin` 签出来的 JWT（306 字符，`sub/school_id/exp/jti`）**在 v6 上无效**。
- `api/f/v6/login` 是 Retrofit `@FormUrlEncoded @POST`，表单字段名从 dex 里确认是
  `encodedUsername` / `encodedPassword`；但**光有正确字段还不够**，必须有 `sign` + `timestamp`，
  否则 400 →（乱填 sign）401。也就是说 v6 也有签名门槛，只是错误码和 v5 不同。

## 2. 签名为什么复刻不了

- v5 `/app/**` 的签名：`ChingoEncrypt.cgapiEnrypt(secret, path+query)`，实现在
  `libAMapSDK_Location_v6_6_0.so`（伪装成高德）。
- 新版 APK（`v5.5.61r-sh`，包名仍是 `net.crigh.mysport`）多了一个 `arm64-v8a` 版本，
  但本机是 x64 Windows，**ARM ELF 不能加载**；库里的密钥与明文串运行时 AES 解密，
  静态提取拿不到。
- 试过的替代：12 组 md5 变体（`MD5(secret+path+Σkv+ts+" "+secret)`）打 `/app/v2/myattendance`
  全部返回 `非法操作，请求验证失败`（61 字节）。

## 3. 于是采用的路

手机端参与（不 root、不需要签名）：

1. **adb 驱动** `deploy/adb-ns.mjs` —— 电脑插着手机时：自动拉起 App → 进「身体素质课」→
   `uiautomator dump` 找「签到/签退」→ `input tap` → 复核 → `POST /api/phone/report` 回本站。
2. **AutoJS** `deploy/autojs-ns.js` —— 不想插电脑时，在手机上跑，直接 HTTP 回报。
3. 本站 `services/phone.js` 把回报合并成一条「身体素质课」场次，和 ptm 的定向越野并存。

## 4. 已排除的路线（别再试）

- 用 `/app/cas/appLogin` 的 JWT 直调 `/api/l/v6/**` → 2001。
- 给 v6 补 `schoolid` / `client` / `imei` / `timestamp` 绕过 2002 → 无效。
- 网页门户（ptm/pft/cts）里找身体素质课签到入口 → 页面里没有（`身体素质` 出现 0 次）。
- 本机加载 `.so` 复刻 `cgapiEnrypt` → ARM 架构不兼容。
