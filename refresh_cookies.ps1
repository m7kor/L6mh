# refresh_cookies.ps1 - Runs as scheduled task to export and upload cookies
# Requires: Helium browser closed during export

$ErrorActionPreference = "Stop"

$projectDir = "C:\Project\discord-yt-streamer"
$logFile = "$projectDir\cookie_refresh.log"
$serverIP = "144.24.217.156"
$serverUser = "ubuntu"
$sshKey = "C:\Users\KH\Desktop\oracle\ssh-key-2026-08-27 (2).key"
$serverPath = "~/discord-yt-audio-bot/cookies.txt"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

try {
    Log "Starting cookie refresh..."

    # Kill Helium if running
    $procs = Get-Process chrome -ErrorAction SilentlyContinue
    if ($procs) {
        Log "Closing Helium ($($procs.Count) processes)..."
        Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    # Launch Helium with remote debugging
    $helium = "C:\Users\KH\AppData\Local\imput\Helium\Application\chrome.exe"
    $userData = "C:\Users\KH\AppData\Local\imput\Helium\User Data"
    $proc = Start-Process -FilePath $helium -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$userData", "--remote-allow-origins=*", "https://www.youtube.com" -PassThru
    Start-Sleep -Seconds 5

    # Export cookies via CDP
    python "$projectDir\cdp_export.py"
    $exitCode = $LASTEXITCODE

    # Kill Helium
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue

    if ($exitCode -ne 0) {
        Log "ERROR: CDP export failed with exit code $exitCode"
        exit 1
    }

    # Upload to server
    Log "Uploading to server..."
    scp -i $sshKey "$projectDir\cookies.txt" "${serverUser}@${serverIP}:${serverPath}"
    if ($LASTEXITCODE -ne 0) {
        Log "ERROR: SCP upload failed"
        exit 1
    }

    # Restart bot
    Log "Restarting bot..."
    ssh -i $sshKey "${serverUser}@${serverIP}" "cd ~/discord-yt-audio-bot && pm2 restart yt-audio-bot && pm2 save"

    Log "Cookie refresh completed successfully!"
} catch {
    Log "ERROR: $_"
    # Make sure Helium is killed
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    exit 1
}
