import subprocess, time, json, websocket, sys

port = 9222
helium_path = r"C:\Users\KH\AppData\Local\imput\Helium\Application\chrome.exe"
user_data = r"C:\Users\KH\AppData\Local\imput\Helium\User Data"

print("Launching Helium with remote debugging...")
proc = subprocess.Popen([
    helium_path,
    f"--remote-debugging-port={port}",
    f"--user-data-dir={user_data}",
    "--remote-allow-origins=*",
    "https://www.youtube.com"
])
time.sleep(5)

import urllib.request
try:
    resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version")
    info = json.loads(resp.read())
    ws_url = info["webSocketDebuggerUrl"]
    print(f"Connected: {info.get('Browser', 'unknown')}")
except Exception as e:
    print(f"Failed to connect: {e}")
    proc.terminate()
    sys.exit(1)

ws = websocket.create_connection(ws_url)

# Get all cookies
ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
result = json.loads(ws.recv())
cookies = result.get("result", {}).get("cookies", [])
print(f"Total cookies: {len(cookies)}")

yt_cookies = [c for c in cookies if 'youtube' in c.get('domain', '') or 'google' in c.get('domain', '')]
print(f"YouTube/Google cookies: {len(yt_cookies)}")

with open(r'C:\Project\discord-yt-streamer\cookies.txt', 'w', encoding='utf-8') as f:
    f.write('# Netscape HTTP Cookie File\n')
    for c in yt_cookies:
        domain = c.get('domain', '')
        name = c.get('name', '')
        value = c.get('value', '')
        path = c.get('path', '/')
        secure = 'TRUE' if c.get('secure', False) else 'FALSE'
        domain_flag = 'TRUE' if domain.startswith('.') else 'FALSE'
        expires = int(c.get('expires', 0))
        http_only = c.get('httpOnly', False)
        if value:
            f.write(f'{domain}\t{domain_flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n')

print("Exported cookies.txt")

# Check for important ones
important = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', 'LOGIN_INFO']
found = [c['name'] for c in yt_cookies if c['name'] in important]
print(f"Key cookies: {', '.join(found)}")

ws.close()
proc.terminate()
print("Done!")
