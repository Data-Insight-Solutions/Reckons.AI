# Mobile Access via QR Code — Local Server Setup

This guide covers running Reckons.AI on a Linux machine (Ubuntu/Debian) with Ollama
as the local inference backend, and accessing the app from a mobile device on the
same Wi-Fi network via QR code.

---

## Overview

```
[Mobile Phone]  ←── Wi-Fi LAN ───→  [Ubuntu Machine]
                                       ├── Vite dev server  :5173
                                       └── Ollama           :11434
```

The mobile browser opens the Reckons.AI SvelteKit app served directly from your
Ubuntu machine. Because both devices share the same LAN, the phone can reach both
the app and the Ollama inference endpoint — no cloud required.

---

## 1. Install Ollama on Ubuntu

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify the install:

```bash
ollama --version
```

Pull a model (start with something small):

```bash
ollama pull llama3.2          # 2GB — good default
ollama pull phi3:mini          # 2.3GB — fast, good for ingest
ollama pull mistral            # 4.1GB — better reasoning
```

Start the server (runs on port 11434 by default):

```bash
ollama serve
```

Ollama runs as a systemd service after install, so on reboot it starts automatically.
Check with `systemctl status ollama`.

---

## 2. Allow cross-origin requests from the phone

By default Ollama only accepts requests from `localhost`. The phone browser hits a
different origin (your machine's LAN IP), so requests will be blocked with a CORS
error unless you override this.

### Option A — allow all origins (simplest, LAN-only risk):

```bash
OLLAMA_ORIGINS="*" ollama serve
```

### Option B — allow your specific phone origin:

```bash
OLLAMA_ORIGINS="http://192.168.1.100:5173" ollama serve
```

Replace `192.168.1.100` with your Ubuntu machine's LAN IP (see step 3).

### Making the setting permanent (systemd):

```bash
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_ORIGINS=*"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

---

## 3. Open firewall ports

> **Security warning:** Opening firewall ports exposes services to everyone on your
> local network. Only do this on a trusted home or personal network — **never on
> public Wi-Fi, hotel networks, or shared office networks.**

The Vite dev server (port 5173) and Ollama (port 11434) must both be reachable from
your phone. Most Linux desktop installs block inbound LAN connections by default.

### Ubuntu / Debian — UFW

Check firewall status first:

```bash
sudo ufw status
```

If the output is `Status: active`, add the rules:

```bash
# Allow the Vite dev server
sudo ufw allow 5173/tcp comment 'Reckons.AI dev server'

# Allow Ollama inference
sudo ufw allow 11434/tcp comment 'Ollama LAN inference'

# Verify
sudo ufw status numbered
```

To remove the rules later (recommended after a session):

```bash
sudo ufw delete allow 5173/tcp
sudo ufw delete allow 11434/tcp
```

### macOS — pf / Application Firewall

macOS typically allows outbound and LAN connections by default. If you have the
Application Firewall enabled (**System Settings → Network → Firewall**), you may
need to allow the Node.js and Ollama binaries:

1. Open **System Settings → Network → Firewall → Options…**
2. Click **+** and add `/usr/local/bin/ollama` (or wherever Ollama is installed).
3. Node.js (for Vite) is usually allowed automatically on first run — accept the
   prompt when it appears.

Alternatively, temporarily disable the firewall during your session and re-enable it
after.

### Windows — Windows Defender Firewall

When you first run `npm run dev -- --host`, Windows should prompt you to allow
network access for Node.js. Click **Allow**.

If it doesn't prompt, or if you dismissed it:

1. Open **Windows Defender Firewall with Advanced Security**
   (`wf.msc` from Run or search).
2. Click **Inbound Rules → New Rule…**
3. Choose **Port**, click Next.
4. Select **TCP**, enter `5173, 11434`, click Next.
5. Choose **Allow the connection**, Next.
6. Check **Private** only (uncheck Domain and Public), Next.
7. Name it `Reckons.AI LAN`, Finish.

To remove later: find the rule in Inbound Rules, right-click → Delete.

### Fedora / RHEL — firewalld

```bash
# Add rules (active until next firewall reload)
sudo firewall-cmd --add-port=5173/tcp --add-port=11434/tcp

# Or make permanent
sudo firewall-cmd --permanent --add-port=5173/tcp
sudo firewall-cmd --permanent --add-port=11434/tcp
sudo firewall-cmd --reload

# Remove later
sudo firewall-cmd --permanent --remove-port=5173/tcp
sudo firewall-cmd --permanent --remove-port=11434/tcp
sudo firewall-cmd --reload
```

---

## 5. Find your machine's LAN IP

```bash
ip addr show | grep 'inet ' | grep -v 127.0.0.1
```

Look for a line like `inet 192.168.1.42/24`. The address before the `/` is your LAN IP.
Write it down — you need it in steps 6 and 7.

---

## 6. Start the Vite dev server on all network interfaces

The default `npm run dev` binds only to `localhost`. The phone can't reach that.
Use the `--host` flag to bind on all interfaces:

```bash
npm run dev -- --host
```

Vite will print something like:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.42:5173/
```

The "Network" URL is what your phone will open. Only devices on the same LAN can
reach it — your app is not exposed to the internet.

---

## 7. Configure the Ollama URL in the app

The app's default Ollama base URL is `http://localhost:11434`, which only resolves
on the machine running the server. The phone needs the LAN IP.

In the app: **Settings → Integrations → Ollama base URL**

Change:
```
http://localhost:11434
```
to:
```
http://192.168.1.42:11434
```

(Use your actual LAN IP from step 5.)

Set the preferred backend to **Ollama** for ingest and/or chat.

---

## 8. Generate a QR code for the phone

In the app: **Settings → Integrations → Mobile Access**

1. Click **"Detect IP"** — the app attempts to auto-detect your LAN IP via WebRTC.
   If detection fails, type it manually (`192.168.1.42`).
2. The port field should match your Vite port (`5173` by default).
3. Choose an expiry duration (7 days is reasonable for personal use).
4. Click **"Reveal QR code"** (there is a 30-second countdown — this is intentional;
   the code contains a session token so treat it like a password).
5. Scan the QR code with your phone's camera.

The phone opens `/mobile?token=...&expires=...`. The app validates the token against
the stored session list and redirects to the Reckoning voice-first interface.

---

## 9. Phone browser requirements

| Browser | Works | Notes |
|---|---|---|
| Chrome for Android | Yes | Full support |
| Firefox for Android | Yes | Full support |
| Safari (iOS 16.4+) | Yes | Requires HTTPS for mic access; HTTP is fine for KB browsing |
| Samsung Internet | Yes | |

**Microphone note:** Browser mic access requires either HTTPS or `localhost`.
Over plain HTTP on a LAN IP, mic access will be blocked on most mobile browsers.
For voice capture features (if/when implemented), use a self-signed TLS cert or
a tunnel like [Tailscale](https://tailscale.com) or `mkcert`.

---

## 10. Troubleshooting

### Phone can't load the app

- Confirm both devices are on the same Wi-Fi network (not guest vs. main).
- Try opening `http://192.168.1.42:5173` directly in the phone browser.
- Check that firewall ports are open (see step 3).
  Quick UFW fix: `sudo ufw allow 5173/tcp && sudo ufw allow 11434/tcp`

### "Token not recognised or already revoked"

- The QR code contains a one-time token stored in the desktop browser's IndexedDB.
  If you cleared browser storage or opened the app in a different browser, the
  session is gone. Generate a new QR code.

### Ollama requests fail on mobile

- Confirm `OLLAMA_ORIGINS` is set correctly (step 2).
- Test from the phone browser console:
  ```javascript
  fetch('http://192.168.1.42:11434/api/tags').then(r => r.json()).then(console.log)
  ```
- Ensure the Ollama URL in Settings uses the LAN IP, not `localhost`.

### Slow inference on mobile

The phone is just a browser — all inference runs on the Ubuntu machine. If responses
are slow, the bottleneck is Ollama on the server, not the phone. Try a smaller model
(`phi3:mini`) or enable GPU acceleration in Ollama:
```bash
ollama info   # shows detected GPU
```

---

## 11. Revoke mobile access

In the app: **Settings → Integrations → Mobile Access**

Each active session is listed with its creation time and expiry. Click the revoke
button next to any session, or **"Revoke all"** to immediately invalidate all tokens.

---

## 12. Security notes

- Tokens are UUIDs with an expiry timestamp. They are stored in IndexedDB (desktop
  browser) and validated on every `/mobile` page load.
- The app never sends tokens to any server — validation is entirely client-side.
- LAN exposure: the dev server is accessible to anyone on your local network while
  running with `--host`. Use for personal/home networks; add firewall rules for
  shared office networks.
- For persistent access without regenerating QR codes, use
  [Tailscale](https://tailscale.com) to give your phone a stable private IP that
  works across networks without exposing ports publicly.
