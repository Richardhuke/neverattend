# NeverAttend 一键部署（Windows Server 2019/2022、Windows 10/11）
#
# 在服务器上以「管理员」打开 PowerShell，粘这两行（第一行下载，第二行执行）：
#   $p="$env:TEMP\na-install.ps1"; irm https://raw.githubusercontent.com/Richardhuke/neverattend/main/deploy/win-install.ps1 -OutFile $p
#   powershell -ExecutionPolicy Bypass -File $p
#
# 可用环境变量覆盖默认值（可选）：
#   $env:NA_PORT=8000               # 监听端口
#   $env:NA_ROOT='C:\neverattend'   # 安装目录
#   $env:NA_MOCK='0'                # 0=接真实浙大体艺，1=演示数据
#   $env:NA_AUTO='0'                # 守护进程是否自动提交（1=是）
#   $env:NA_ACCESS_KEY='xxxx'       # 访问密钥，留空则每次随机生成
#   $env:NA_REPO='Richardhuke/neverattend' ; $env:NA_BRANCH='main'
#
# 脚本做六件事：环境检查 → 装 Node → 拉源码 → 装依赖并构建前端 → 写 run.cmd + 开机自启 → 放行防火墙并自检。
# 脚本是幂等的，失败后重跑即可（已装的 Node、已下的源码会复用）。
#
# v2 修复：调用外部命令时临时把 ErrorActionPreference 降为 Continue，输出统一写进日志文件再回显末几行。
#         v1 因为 2>&1 把 npm 写到 stderr 的 warning（npm 11 的 install-scripts allowScripts 提示）
#         变成 NativeCommandError，在 Stop 下一抛就中止，构建其实根本没跑起来。

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Root   = if ($env:NA_ROOT)  { $env:NA_ROOT }  else { 'C:\neverattend' }
$Port   = if ($env:NA_PORT)  { [int]$env:NA_PORT } else { 8000 }
$Repo   = if ($env:NA_REPO)  { $env:NA_REPO }  else { 'Richardhuke/neverattend' }
$Branch = if ($env:NA_BRANCH){ $env:NA_BRANCH } else { 'main' }
$Mock   = if ($env:NA_MOCK)  { $env:NA_MOCK }  else { '0' }
$Auto   = if ($env:NA_AUTO)  { $env:NA_AUTO }  else { '0' }
$Key = $env:NA_ACCESS_KEY
if (-not $Key) {
  # 重装时沿用已有 run.cmd 里的钥匙，避免「脚本打印的钥匙和运行进程不一致」
  $oldRun = Join-Path $Root 'run.cmd'
  if (Test-Path $oldRun) {
    $m = Select-String -Path $oldRun -Pattern 'ACCESS_KEY=(\S+)' | Select-Object -First 1
    if ($m) { $Key = $m.Matches[0].Groups[1].Value }
  }
}
if (-not $Key) { $Key = -join ('23456789abcdefghjkmnpqrstuvwxyz'.ToCharArray() | Get-Random -Count 20) }

$logDir = Join-Path $Root 'logs'

function Step($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

# 在指定目录跑一条命令，输出全部落到日志文件，只回显末几行给屏幕。
# 关键：命令用 cmd /c 执行并把 2>&1 重定向进文件，PowerShell 只看到退出码，
# 不会把 npm 写到 stderr 的 warning 当成终止性错误。
function Invoke-Native {
  param(
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [Parameter(Mandatory=$true)][string]$Exe,
    [string[]]$Argv = @(),
    [Parameter(Mandatory=$true)][string]$LogName,
    [int]$TailLines = 8
  )
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $log = Join-Path $logDir $LogName
  if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
  # 调用运算符 + 数组参数：路径含空格不用操心引号。
  # 临时把 ErrorActionPreference 放回 Continue —— 否则 npm 写到 stderr 的 warning
  # 经 2>&1 变成 ErrorRecord，在 Stop 下抛 NativeCommandError 直接中止（v1 就死在这）。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $WorkDir
  try {
    & $Exe @Argv 2>&1 | Out-File -FilePath $log -Encoding utf8
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $prev
  }
  if (Test-Path $log) {
    Get-Content $log -Tail $TailLines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  }
  return [int]$code
}

function Install-Deps {
  param([string]$Dir, [string]$Label, [string]$LogName)
  $code = Invoke-Native -WorkDir $Dir -Exe $npmCmd -Argv @('ci','--no-audit','--no-fund') -LogName $LogName
  if ($code -ne 0) {
    Warn "$Label 首次失败（exit $code），改用国内镜像 registry.npmmirror.com 重试…"
    $code = Invoke-Native -WorkDir $Dir -Exe $npmCmd -Argv @('ci','--no-audit','--no-fund','--registry=https://registry.npmmirror.com') -LogName ($LogName -replace '\.log$', '.retry.log')
  }
  if ($code -ne 0) { throw "$Label 失败（exit $code），完整日志在 $logDir" }
}

# ---------- 0. 前置检查 ----------
Step '0/6 环境检查'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '请用「管理员身份」运行 PowerShell（开始菜单右键 → 终端(管理员)）' }
Ok "管理员权限；系统 $([Environment]::OSVersion.VersionString)"
if (Test-Path $Root) { Ok "安装目录已存在：$Root（将原地更新）" } else { New-Item -ItemType Directory -Path $Root -Force | Out-Null; Ok "已创建 $Root" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# ---------- 1. Node ----------
Step '1/6 Node.js'
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$npmCmd  = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (Test-Path $nodeExe) {
  Ok "已安装：$(& $nodeExe -v)（$npmCmd）"
} else {
  $idx = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v22.x/' -UseBasicParsing -TimeoutSec 60).Content
  $msi = [regex]::Match($idx, 'node-v[\d.]+-x64\.msi').Value
  if (-not $msi) { throw '从 nodejs.org 解析 msi 文件名失败，请手动安装 Node 22 后重跑' }
  $msiPath = Join-Path $env:TEMP $msi
  Warn "下载 $msi"
  Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$msi" -OutFile $msiPath -UseBasicParsing -TimeoutSec 600
  Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait
  if (-not (Test-Path $nodeExe)) { throw 'Node 安装后仍找不到 node.exe（可能刚装完 PATH 未刷新，重开 PowerShell 再跑一次）' }
  Ok "已安装：$(& $nodeExe -v)"
}
$nodeMajor = [int]((& $nodeExe -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node 版本过低（v$nodeMajor），需要 20 以上" }

# ---------- 2. 源码 ----------
Step '2/6 拉取源码'
$zip = Join-Path $env:TEMP "neverattend-$Branch.zip"
$tmp = Join-Path $env:TEMP "neverattend-unzip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing -TimeoutSec 300
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
Copy-Item (Join-Path $src.FullName '*') $Root -Recurse -Force
Ok "源码已就位：$Root（$Repo@$Branch）"

# ---------- 3. 依赖与构建 ----------
Step '3/6 安装依赖并构建前端（约 1-3 分钟）'
$fe = Join-Path $Root 'frontend'
$be = Join-Path $Root 'backend'

Install-Deps -Dir $fe -Label '前端依赖' -LogName 'npm-frontend.log'
Ok '前端依赖就绪'

$code = Invoke-Native -WorkDir $fe -Exe $npmCmd -Argv @('run','build') -LogName 'build.log' -TailLines 10
if ($code -ne 0) { throw "前端构建失败（exit $code），完整日志：$logDir\build.log" }
$staticIndex = Join-Path $be 'static\index.html'
if (-not (Test-Path $staticIndex)) { throw "构建产物缺失：$staticIndex" }
$assetName = 'unknown'
try {
  $idxHtml = Get-Content $staticIndex -Raw
  if ($idxHtml -match 'assets/(index-[A-Za-z0-9_-]+\.js)') { $assetName = $Matches[1] }
} catch {}
Ok "前端已构建 → backend\static（产物 $assetName）"

Install-Deps -Dir $be -Label '后端依赖' -LogName 'npm-backend.log'
Ok '后端依赖就绪'

# ---------- 4. 启动脚本 + 开机自启 ----------
Step '4/6 生成 run.cmd 与开机自启'
$runCmd = Join-Path $Root 'run.cmd'
$lines = @(
  '@echo off',
  'chcp 65001 >nul',
  "cd /d `"$be`"",
  "set PORT=$Port",
  'set HOST=0.0.0.0',
  'set STATIC_DIR=./static',
  "set TYYS_MOCK=$Mock",
  'set WATCH_INTERVAL_MS=10000',
  "set WATCH_AUTO_CHECKIN=$Auto",
  "set ACCESS_KEY=$Key",
  'set CORS_ORIGIN=https://richardhuke.github.io',
  ':loop',
  "`"$nodeExe`" src\index.js >> `"$logDir\app.log`" 2>&1",
  'timeout /t 5 /nobreak >nul',
  'goto loop'
)
Set-Content -Path $runCmd -Value $lines -Encoding ASCII
Ok "已写 $runCmd"

# 先停任务再杀进程：只 /run 不 /end 的话，任务已在跑时 schtasks 会直接报「已在运行」，
# 老进程继续服务旧代码，看起来就是「装了但没生效」。
schtasks /end /tn NeverAttend 2>&1 | Out-Null
Start-Sleep -Seconds 2
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
schtasks /create /tn NeverAttend /tr "`"$runCmd`"" /sc onstart /ru SYSTEM /rl HIGHEST /f | Out-Null
schtasks /run /tn NeverAttend 2>&1 | Out-Null
Ok '计划任务 NeverAttend 已注册并启动（开机自启、SYSTEM 权限）'

# ---------- 5. 防火墙 ----------
Step '5/6 防火墙放行'
if (-not (Get-NetFirewallRule -DisplayName "NeverAttend $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "NeverAttend $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
}
# 双保险：万一上面那条规则存在但被禁用/被策略覆盖，再用 netsh 叠加一条（同名会报「已存在」，忽略即可）
& $env:ComSpec /c "netsh advfirewall firewall add rule name=`"NeverAttend $Port (netsh)`" dir=in action=allow protocol=TCP localport=$Port" 2>&1 | Out-Null
Ok "已放行 TCP $Port（阿里云还需在「安全组」里再放行一次）"

# ---------- 6. 自检 ----------
Step '6/6 自检'
Start-Sleep -Seconds 8
$localOk = $false
for ($i = 0; $i -lt 6 -and -not $localOk; $i++) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/config" -UseBasicParsing -TimeoutSec 10
    $cfg = $r.Content | ConvertFrom-Json
    $localOk = ($r.StatusCode -eq 200)
    if ($localOk) { Ok "本机 /api/config 200；模式=$($cfg.mode)；tyys=$($cfg.tyysBase)" }
  } catch {
    if ($i -lt 5) { Start-Sleep -Seconds 3 }
    else { Warn "本机 /api/config 请求失败：$($_.Exception.Message)（看日志 $logDir\app.log）" }
  }
}

# 版本指纹：/api/version 返回线上真实在跑的前端产物名 + 已注册路由，用来确认「装的是新代码」
try {
  $v = (Invoke-WebRequest "http://127.0.0.1:$Port/api/version" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
  if ($v.asset) { Ok "线上版本：$($v.asset)（构建于 $($v.buildAt)）" } else { Warn '线上 /api/version 未返回产物名' }
  $hasApp = @($v.routes) -match 'applogin'
  if ($hasApp) { Ok '调试路由已就位：/api/debug/applogin、/api/debug/appcall' }
  else { Warn '线上没有 /api/debug/applogin —— 说明跑的还是旧代码，需要重跑本脚本' }
} catch {
  Warn "本机 /api/version 请求失败（多半是旧版本没有这个路由，重跑脚本即可）：$($_.Exception.Message)"
}

$pubIp = ''
try { $pubIp = (Invoke-WebRequest 'http://100.100.100.200/latest/meta-data/eipv4' -UseBasicParsing -TimeoutSec 5).Content } catch {}
if (-not $pubIp) { try { $pubIp = (Invoke-WebRequest 'http://100.100.100.200/latest/meta-data/public-ipv4' -UseBasicParsing -TimeoutSec 5).Content } catch {} }

# 绑定检查：必须看到 0.0.0.0:PORT（或 [::]:PORT），只绑 127.0.0.1 外网就连不上
$bind = (netstat -ano | Select-String -Pattern ":$Port\s" | Select-String -Pattern "LISTENING" | Select-Object -First 1)
if ($bind) {
  $bindText = ($bind.Line -replace '\s+', ' ').Trim()
  if ($bindText -match '0\.0\.0\.0:' -or $bindText -match '\[::\]:') { Ok "监听地址正确：$bindText" }
  else { Warn "监听地址可能只绑了回环：$bindText —— 检查 HOST 环境变量是否被覆盖" }
} else {
  Warn "没看到 $Port 处于 LISTENING，进程可能没起来（看 $logDir\app.log）"
}
# 注意：阿里云 ECS 不支持用公网 IP 从机器内部回连自己（无 NAT 回环），所以这里不做公网自探，
# 外网可达性请用手机流量或另一台机器打开 http://公网IP:PORT/api/config 验证。

Write-Host "`n================ 部署完成 ================" -ForegroundColor Green
if ($pubIp) { Write-Host "公网入口： http://$pubIp`:$Port/?key=$Key" -ForegroundColor Green }Write-Host "本机入口： http://127.0.0.1:$Port/?key=$Key"
Write-Host "访问密钥： $Key    （首次带 ?key= 打开，浏览器会记住；不要外传）"
Write-Host "数据模式： $(if ($Mock -eq '1') { 'MOCK 演示数据' } else { '真实浙大体艺' })；守护自动提交：$(if ($Auto -eq '1') { '开' } else { '关（页面上手动启动）' })"
Write-Host "日志：     $logDir\app.log"
Write-Host "重启：     schtasks /end /tn NeverAttend ; schtasks /run /tn NeverAttend"
Write-Host "更新：     重跑本脚本即可（源码覆盖，node_modules 复用）"
if (-not $localOk) { Write-Host "`n注意：自检未通过，先看日志再做别的。" -ForegroundColor Yellow }
Write-Host '==========================================' -ForegroundColor Green
