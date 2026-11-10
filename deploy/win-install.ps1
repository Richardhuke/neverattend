# NeverAttend 一键部署（Windows Server 2019/2022、Windows 10/11）
#
# 在服务器上以「管理员」打开 PowerShell，粘这两行（第一行下载，第二行执行）：
#   $p="$env:TEMP\na-install.ps1"; irm https://raw.githubusercontent.com/Richardhuke/neverattend/main/deploy/win-install.ps1 -OutFile $p
#   powershell -ExecutionPolicy Bypass -File $p
#
# 可用环境变量覆盖默认值（可选）：
#   $env:NA_PORT=8000            # 监听端口
#   $env:NA_ROOT='C:\neverattend' # 安装目录
#   $env:NA_MOCK='0'             # 0=接真实浙大体艺，1=演示数据
#   $env:NA_AUTO='0'             # 守护进程是否自动提交（1=是）
#   $env:NA_ACCESS_KEY='xxxx'    # 访问密钥，留空则每次随机生成
#   $env:NA_REPO='Richardhuke/neverattend' ; $env:NA_BRANCH='main'
#
# 脚本做五件事：装 Node 22 → 拉源码 → 装依赖并构建前端 → 写 run.cmd + 开机自启计划任务 → 放行防火墙并自检。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Root   = if ($env:NA_ROOT)  { $env:NA_ROOT }  else { 'C:\neverattend' }
$Port   = if ($env:NA_PORT)  { [int]$env:NA_PORT } else { 8000 }
$Repo   = if ($env:NA_REPO)  { $env:NA_REPO }  else { 'Richardhuke/neverattend' }
$Branch = if ($env:NA_BRANCH){ $env:NA_BRANCH } else { 'main' }
$Mock   = if ($env:NA_MOCK)  { $env:NA_MOCK }  else { '0' }
$Auto   = if ($env:NA_AUTO)  { $env:NA_AUTO }  else { '0' }
$Key    = if ($env:NA_ACCESS_KEY) { $env:NA_ACCESS_KEY } else { -join ('23456789abcdefghjkmnpqrstuvwxyz'.ToCharArray() | Get-Random -Count 20) }

function Step($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

# ---------- 0. 前置检查 ----------
Step '0/6 环境检查'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '请用「管理员身份」运行 PowerShell（开始菜单右键 → 终端(管理员)）' }
Ok "管理员权限；系统 $([Environment]::OSVersion.VersionString)"
if (Test-Path $Root) { Ok "安装目录已存在：$Root（将原地更新）" } else { New-Item -ItemType Directory -Path $Root -Force | Out-Null; Ok "已创建 $Root" }

# ---------- 1. Node 22 LTS ----------
Step '1/6 Node.js 22 LTS'
$nodeExe = "$env:ProgramFiles\nodejs\node.exe"
$npmCmd  = "$env:ProgramFiles\nodejs\npm.cmd"
if (Test-Path $nodeExe) {
  Ok "已安装：$(& $nodeExe -v)"
} else {
  $idx = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v22.x/' -UseBasicParsing -TimeoutSec 60).Content
  $msi = [regex]::Match($idx, 'node-v[\d.]+-x64\.msi').Value
  if (-not $msi) { throw '从 nodejs.org 解析 msi 文件名失败，请手动安装 Node 22 后重跑' }
  $msiPath = Join-Path $env:TEMP $msi
  Warn "下载 $msi"
  Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$msi" -OutFile $msiPath -UseBasicParsing -TimeoutSec 600
  Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait
  if (-not (Test-Path $nodeExe)) { throw 'Node 安装后仍找不到 node.exe' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  Ok "已安装：$(& $nodeExe -v)"
}

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
Push-Location (Join-Path $Root 'frontend')
& $npmCmd ci --no-audit --no-fund 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '前端依赖安装失败（npm ci）' }
& $npmCmd run build 2>&1 | Select-Object -Last 6
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '前端构建失败（npm run build）' }
Pop-Location
$staticIndex = Join-Path $Root 'backend\static\index.html'
if (-not (Test-Path $staticIndex)) { throw "构建产物缺失：$staticIndex" }
Ok "前端已构建 → backend\static"

Push-Location (Join-Path $Root 'backend')
& $npmCmd ci --no-audit --no-fund 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '后端依赖安装失败（npm ci）' }
Pop-Location
Ok '后端依赖就绪'

# ---------- 4. 启动脚本 + 开机自启 ----------
Step '4/6 生成 run.cmd 与开机自启'
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$runCmd = Join-Path $Root 'run.cmd'
$lines = @(
  '@echo off',
  'chcp 65001 >nul',
  "cd /d `"$Root\backend`"",
  "set PORT=$Port",
  "set STATIC_DIR=./static",
  "set TYYS_MOCK=$Mock",
  "set WATCH_INTERVAL_MS=10000",
  "set WATCH_AUTO_CHECKIN=$Auto",
  "set ACCESS_KEY=$Key",
  "set CORS_ORIGIN=https://richardhuke.github.io",
  ':loop',
  "`"$nodeExe`" src\index.js >> `"$logDir\app.log`" 2>&1",
  'timeout /t 5 /nobreak >nul',
  'goto loop'
)
Set-Content -Path $runCmd -Value $lines -Encoding ASCII
Ok "已写 $runCmd"

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
schtasks /create /tn NeverAttend /tr "`"$runCmd`"" /sc onstart /ru SYSTEM /rl HIGHEST /f | Out-Null
schtasks /run /tn NeverAttend | Out-Null
Ok '计划任务 NeverAttend 已注册并启动（开机自启、SYSTEM 权限）'

# ---------- 5. 防火墙 ----------
Step '5/6 防火墙放行'
if (-not (Get-NetFirewallRule -DisplayName "NeverAttend $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "NeverAttend $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
}
Ok "已放行 TCP $Port（阿里云还需在「安全组」里再放行一次）"

# ---------- 6. 自检 ----------
Step '6/6 自检'
Start-Sleep -Seconds 6
$localOk = $false
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/config" -UseBasicParsing -TimeoutSec 15
  $cfg = $r.Content | ConvertFrom-Json
  $localOk = ($r.StatusCode -eq 200)
  Ok "本机 /api/config 200；模式=$($cfg.mode)；tyys=$($cfg.tyysBase)"
} catch { Warn "本机 /api/config 请求失败：$($_.Exception.Message)（看日志 $logDir\app.log）" }

$pubIp = ''
try { $pubIp = (Invoke-WebRequest 'http://100.100.100.200/latest/meta-data/eipv4' -UseBasicParsing -TimeoutSec 5).Content } catch {}
if (-not $pubIp) { try { $pubIp = (Invoke-WebRequest 'http://100.100.100.200/latest/meta-data/public-ipv4' -UseBasicParsing -TimeoutSec 5).Content } catch {} }

Write-Host "`n================ 部署完成 ================" -ForegroundColor Green
if ($pubIp) { Write-Host "公网入口： http://$pubIp`:$Port/?key=$Key" -ForegroundColor Green }
Write-Host "本机入口： http://127.0.0.1:$Port/?key=$Key"
Write-Host "访问密钥： $Key    （首次带 ?key= 打开，浏览器会记住；不要外传）"
Write-Host "数据模式： $(if ($Mock -eq '1') { 'MOCK 演示数据' } else { '真实浙大体艺' })；守护自动提交：$(if ($Auto -eq '1') { '开' } else { '关（页面上手动启动）' })"
Write-Host "日志：     $logDir\app.log"
Write-Host "重启：     schtasks /end /tn NeverAttend ; schtasks /run /tn NeverAttend"
Write-Host "更新：     重跑本脚本即可（源码覆盖，node_modules 复用）"
if (-not $localOk) { Write-Host "`n注意：自检未通过，先看日志再做别的。" -ForegroundColor Yellow }
Write-Host '==========================================' -ForegroundColor Green
