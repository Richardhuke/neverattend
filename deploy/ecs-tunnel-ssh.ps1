# NeverAttend - SSH reverse tunnel (no download needed)
# Uses built-in OpenSSH client. Exposes local :8000 as https://xxxx.lhr.life
$ErrorActionPreference = 'Continue'

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Write-Host '[!!] ssh client not found. Run: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
  exit 1
}

$app = $false
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8000/api/config' -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { $app = $true }
} catch {}
if (-not $app) {
  Write-Host '[..] app not responding, starting scheduled task NeverAttend'
  & schtasks /run /tn NeverAttend | Out-Null
  Start-Sleep -Seconds 8
}

Write-Host '[OK] starting reverse tunnel on localhost.run ...'
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:8000 nokey@localhost.run
