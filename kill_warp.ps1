while ($true) {
    echo "Trying to connect..."
    ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no -i "C:\Users\KH\Desktop\oracle\ssh-key-2026-08-27 (2).key" ubuntu@144.24.217.156 "sudo systemctl disable warp-svc && sudo systemctl stop warp-svc && warp-cli --accept-tos disconnect"
    if ($LASTEXITCODE -eq 0) {
        echo "SUCCESS! WARP IS DEAD!"
        break
    }
    Start-Sleep -Milliseconds 100
}
