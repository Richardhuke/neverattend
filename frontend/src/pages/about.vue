<template>
  <section>
    <div class="page-head"><h2>About</h2><span class="chip">FAQ</span></div>

    <div class="card">
      <div class="card-head"><h3>这是什么</h3></div>
      <p class="muted small" style="margin-top:0">
        NeverAttend 面向浙大体艺（tyys）「身体素质课」考勤：把 CAS 登录、场次拉取、定位/扫码/口令签到收进一个网页，
        并用一个常驻守护每 10 秒扫描一次，发现待签到场次就自动提交。界面与交互沿用 NeverRun 的结构：Run / Manage / About + 隐藏的 Config 面板。
      </p>

      <div class="card-head" style="margin-top:18px"><h3>两件事不要混</h3></div>
      <div class="rows">
        <div class="row"><span class="k">凭据</span><span class="v">只在本机浏览器保存；密码用 AES 混淆（密钥在前端包里，属于防明文，不是加密保险箱）。</span></div>
        <div class="row"><span class="k">签到</span><span class="v">由本机后端带你的 JWT 直接请求体艺接口；后端不落库，进程重启即清空会话。</span></div>
      </div>

      <div class="card-head" style="margin-top:18px"><h3>为什么分两步</h3></div>
      <p class="small" style="margin:0">
        体艺的签到接口对时间窗与场次状态校验较严：先拉到"待签到"的场次，再在窗口内提交。
        自动签到就是把这两步放进 10 秒轮询里：轮询（轻）→ 判定（窗口 + 未签到）→ 提交（重）→ 复核。
      </p>

      <div class="card-head" style="margin-top:18px"><h3>免责</h3></div>
      <p class="muted small" style="margin:0">
        考勤是课程成绩的一部分。本工具仅为个人自动化实验，请自行确认任课教师与学校规定；因代签产生的后果自负。
      </p>
    </div>

    <div class="card">
      <div class="card-head"><h3>接口一览</h3></div>
      <table class="table">
        <thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td class="mono">POST</td><td class="mono">api/getToken</td><td>账密 → ZJUAM CAS → JWT</td></tr>
          <tr><td class="mono">POST</td><td class="mono">api/verifyToken</td><td>校验 JWT，返回学号/姓名/学院</td></tr>
          <tr><td class="mono">GET</td><td class="mono">api/attendance/status</td><td>教学班 + 考勤场次</td></tr>
          <tr><td class="mono">POST</td><td class="mono">api/checkin</td><td>签到，SSE 推 8 步进度</td></tr>
          <tr><td class="mono">GET</td><td class="mono">api/watch/state</td><td>守护运行态 + 事件流</td></tr>
          <tr><td class="mono">POST</td><td class="mono">api/watch/start</td><td>启动 10s 轮询</td></tr>
          <tr><td class="mono">GET</td><td class="mono">api/config</td><td>模式、路径表、步骤定义</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
