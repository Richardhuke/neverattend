# NeverAttend 公网隧道（绕过安全组）
# 作用：确认本机 8000 在跑 -> 下载 cloudflared -> 开一条临时 HTTPS 公网地址
# 用法（管理员 PowerShell，两行）：
#   $p="$env:TEMP\na-tunnel.ps1"; irm https://raw.githubusercontent.com/Richardhuke/neverattend/main/deploy/win-tunnel.ps1 -OutFile $p
#   powershell -ExecutionPolicy Bypass -File $p
$ErrorActionPreference = 'Stop'
$Root = 'C:\neverattend'
$Port = 8000
$Bin  = Join-Path $Root 'bin'
$Logs = Join-Path $Root 'logs'
$Exe  = Join-Path $Bin 'cloudflared.exe'
$CfgLog = Join-Path $Logs 'cloudflared.log'
$UrlFile = Join-Path $Root 'tunnel-url.txt'
$Key = $env:NA_KEY
if (-not $Key) {
  $runCmd = Join-Path $Root 'run.cmd'
  if (Test-Path $runCmd) {
    $m = Select-String -Path $runCmd -Pattern 'ACCESS_KEY=(\S+)' | Select-Object -First 1
    if ($m) { $Key = $m.Matches[0].Groups[1].Value }
  }
}

function Ok($m)   { Write-Host "[OK] $m"   -ForegroundColor Green }
function Bad($m)  { Write-Host "[!!] $m"   -ForegroundColor Red }
function Info($m) { Write-Host "[..] $m"   -ForegroundColor Gray }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Bad '请用「管理员身份」运行 PowerShell 再执行本脚本'; exit 1 }
New-Item -ItemType Directory -Force -Path $Bin, $Logs | Out-Null

# ---------- 1. 确认应用在跑 ----------
function Test-App {
  try { $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/config" -UseBasicParsing -TimeoutSec 5; return ($r.StatusCode -eq 200) } catch { return $false }
}
if (-not (Test-App)) {
  Bad "本机 $Port 没响应，尝试重启守护任务 NeverAttend ..."
  & schtasks /run /tn NeverAttend 2>&1 | Out-Null
  for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Seconds 3; if (Test-App) { break } }
}
if (-not (Test-App)) {
  Bad "重启后仍然不通，先看日志：$Logs\app.log"
  if (Test-Path (Join-Path $Logs 'app.log')) { Get-Content (Join-Path $Logs 'app.log') -Tail 15 }
  exit 1
}
Ok "本机 http://127.0.0.1:$Port 正常"
$bind = (netstat -ano | Select-String -Pattern ":$Port\s" | Select-String -Pattern 'LISTENING' | Select-Object -First 1)
if ($bind) { Info ('监听：' + (($bind.Line -replace '\s+', ' ').Trim())) }

# ---------- 2. 下载 cloudflared ----------
if (-not (Test-Path $Exe) -or ((Get-Item $Exe).Length -lt 5MB)) {
  $urls = @(
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  )
  $got = $false
  foreach ($u in $urls) {
    try {
      Info "下载 cloudflared：$u"
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest $u -OutFile $Exe -UseBasicParsing -TimeoutSec 120
      if ((Get-Item $Exe).Length -gt 5MB) { $got = $true; break }
    } catch { Info "失败：$($_.Exception.Message)" }
  }
  if (-not $got) { Bad 'cloudflared 下载失败（网络受限），可改用安全组放行 8000 的方案'; exit 1 }
}
Ok ('cloudflared 就绪：' + [math]::Round((Get-Item $Exe).Length / 1MB, 1) + ' MB')

# ---------- 3. 启动隧道 ----------
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if (Test-Path $CfgLog) { Remove-Item $CfgLog -Force -ErrorAction SilentlyContinue }
$args = @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate', '--logfile', $CfgLog, '--loglevel', 'info')
Start-Process -FilePath $Exe -ArgumentList $args -WindowStyle Hidden
Info '等待隧道建立 ...'
$pub = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $CfgLog) {
    $hit = Select-String -Path $CfgLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -First 1
    if ($hit) { $pub = $hit.Matches[0].Value; break }
  }
}
if (-not $pub) {
  Bad "没拿到隧道地址，日志：$CfgLog"
  if (Test-Path $CfgLog) { Get-Content $CfgLog -Tail 20 }
  exit 1
}
Ok "隧道已建立：$pub"

# ---------- 4. 自测并从服务器侧确认隧道可用 ----------
$a = ''
if ($Key) { $a = "?key=$Key" }
try {
  $t = Invoke-WebRequest "$pub/api/config" -UseBasicParsing -TimeoutSec 15
  Ok "隧道自测：HTTP $($t.StatusCode)（本机经 Cloudflare 回源成功）"
} catch { Bad "隧道自测失败：$($_.Exception.Message)" }

$entry = "$pub/$a"
Set-Content -Path $UrlFile -Value $entry -Encoding ASCII

# ---------- 5. 可选：开机自动拉起隧道 ----------
$taskName = 'NeverAttendTunnel'
& schtasks /create /tn $taskName /tr "`"$Exe`" tunnel --url http://127.0.0.1:$Port --no-autoupdate --logfile `"$CfgLog`"" /sc onstart /ru SYSTEM /rl HIGHEST /f 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "已注册开机自启：$taskName（重启服务器后地址会变）" }

Write-Host ''
Write-Host '================== 公网入口（Cloudflare 临时地址，HTTPS） ==================' -ForegroundColor Cyan
Write-Host ("公开地址： " + $entry) -ForegroundColor Yellow
Write-Host ("访 问 钥： " + $(if ($Key) { $Key } else { '（未取到，见 run.cmd 里的 ACCESS_KEY）' }))
Write-Host ("地址已存： " + $UrlFile)
Write-Host ("隧道日志： " + $CfgLog)
Write-Host  '说明：此地址不经过安全组、不需要域名，手机流量可直接打开；'
Write-Host  '     但每次重启会变，且速度取决于 Cloudflare 节点。'
Write-Host  '想固定地址：在阿里云安全组入方向放行 8000/TCP（授权对象 0.0.0.0/0），'
Write-Host  '     然后直接用 http://121.196.174.13:8000/?key=<访问钥> 即可。'
Write-Host '========================================================================' -ForegroundColor Cyan
