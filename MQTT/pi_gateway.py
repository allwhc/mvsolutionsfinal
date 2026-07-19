#!/usr/bin/env python3
"""
SenseFlow Pi gateway — runs on Raspberry Pi or any Linux box on the same LAN.

Responsibilities:
  1. Listen for UDP discovery broadcasts from ESP32 devices.
  2. Auto-register each new device into Mosquitto's password file + ACL.
  3. Reload Mosquitto so the device can authenticate immediately.

Pair with: mosquitto MQTT broker (apt install mosquitto mosquitto-clients).

Mosquitto config (/etc/mosquitto/conf.d/senseflow.conf):
    listener 1883
    allow_anonymous false
    password_file /etc/mosquitto/senseflow_passwd
    acl_file     /etc/mosquitto/senseflow_acl
"""

import socket
import subprocess
import hashlib
import os
import time
import threading

# ─── MUST MATCH FIRMWARE #define MQTT_SECRET ───────────────────────
MQTT_SECRET = "mvs_kalp_2026_xY9k_rotate_me"

# ─── Paths (adjust if your distro uses different locations) ────────
PASSWORD_FILE = "/etc/mosquitto/senseflow_passwd"
ACL_FILE      = "/etc/mosquitto/senseflow_acl"
MOSQUITTO_PW  = "/usr/bin/mosquitto_passwd"

# ─── Network ───────────────────────────────────────────────────────
DISCOVERY_PORT = 1900
DISCOVERY_MSG  = b"SENSEFLOW_DISCOVER"
DISCOVERY_REPLY = b"SENSEFLOW_HERE"

# In-memory set of devices already registered this session (avoids
# reloading Mosquitto for every duplicate broadcast).
registered = set()
lock = threading.Lock()


def derive_password(device_code: str) -> str:
    """First 16 hex chars of SHA256(deviceCode + MQTT_SECRET). Matches firmware."""
    h = hashlib.sha256((device_code + MQTT_SECRET).encode()).hexdigest()
    return h[:16]


def is_in_password_file(device_code: str) -> bool:
    if not os.path.exists(PASSWORD_FILE):
        return False
    with open(PASSWORD_FILE) as f:
        for line in f:
            if line.startswith(device_code + ":"):
                return True
    return False


def add_to_password_file(device_code: str, password: str):
    """Use mosquitto_passwd to add the entry (handles hashing format)."""
    if not os.path.exists(PASSWORD_FILE):
        # Create the file first; -c flag creates new password file
        subprocess.run([MOSQUITTO_PW, "-b", "-c", PASSWORD_FILE,
                        device_code, password], check=True)
    else:
        subprocess.run([MOSQUITTO_PW, "-b", PASSWORD_FILE,
                        device_code, password], check=True)


def add_to_acl(device_code: str):
    """Restrict device to its own topic tree."""
    block = (
        f"\nuser {device_code}\n"
        f"topic readwrite senseflow/{device_code}/#\n"
    )
    # Don't add duplicates
    if os.path.exists(ACL_FILE):
        with open(ACL_FILE) as f:
            if f"user {device_code}\n" in f.read():
                return
    with open(ACL_FILE, "a") as f:
        f.write(block)


def reload_mosquitto():
    """Reload broker so new creds + ACL take effect without dropping clients."""
    try:
        subprocess.run(["systemctl", "reload", "mosquitto"], check=True)
        print("[GW] Mosquitto reloaded")
    except subprocess.CalledProcessError as e:
        print(f"[GW] reload failed: {e}")


def register_device(device_code: str):
    """Add device to password file + ACL + reload broker. Idempotent."""
    with lock:
        if device_code in registered:
            return
        password = derive_password(device_code)
        if not is_in_password_file(device_code):
            add_to_password_file(device_code, password)
            add_to_acl(device_code)
            reload_mosquitto()
            print(f"[GW] Registered: {device_code}")
        else:
            print(f"[GW] Already in pw file: {device_code}")
        registered.add(device_code)


def discovery_loop():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', DISCOVERY_PORT))
    print(f"[GW] Listening for SenseFlow discovery on UDP {DISCOVERY_PORT}")
    while True:
        try:
            data, addr = s.recvfrom(128)
            if data != DISCOVERY_MSG:
                continue
            print(f"[GW] Discovery from {addr[0]}")
            # Reply with marker (firmware ignores body, just uses sender IP)
            s.sendto(DISCOVERY_REPLY, addr)
            # We don't know the deviceCode from discovery alone — it's announced
            # via MQTT once connected. So registration happens lazily when the
            # device fails to authenticate the first time:
            #   1. Device connects with username=deviceCode, fails (not in pw file)
            #   2. Reconnects every 5s
            #   3. We need a different signal — see mqtt_watcher_loop below
        except Exception as e:
            print(f"[GW] discovery error: {e}")
            time.sleep(1)


def mqtt_watcher_loop():
    """Watch Mosquitto log for failed authentications. Extract username
    (deviceCode), auto-register, then device's next reconnect succeeds.

    Requires: log_dest file /var/log/mosquitto/mosquitto.log in mosquitto.conf
    """
    LOG = "/var/log/mosquitto/mosquitto.log"
    if not os.path.exists(LOG):
        print(f"[GW] {LOG} not found — auto-register via log watcher disabled")
        return
    # `tail -F` to follow rotations
    proc = subprocess.Popen(["tail", "-F", "-n", "0", LOG],
                            stdout=subprocess.PIPE, text=True)
    print(f"[GW] Watching {LOG} for unauthenticated connects")
    for line in proc.stdout:
        # Mosquitto logs failed auth like:
        #   "Client sf-SF-XXXX-SN disconnected, not authorised."
        # And before that the connect attempt mentions the username.
        # Easiest: parse "New client connected ... as sf-SF-XXXX-SN" then
        # cross-reference with auth failure. But simpler heuristic:
        if "Client connection from" in line and "failed authentication" in line:
            # Format: "Client connection from <ip> failed authentication."
            # We don't get the username here in default log format.
            pass
        # Better: enable `log_type all` and look for the username line:
        # "New connection from <ip>:<port> on port 1883.\n"
        # "New client connected from <ip>:<port> as sf-<deviceCode>"
        if "New client connected" in line and " as sf-" in line:
            try:
                code = line.split(" as sf-")[1].strip().split()[0]
                register_device(code)
            except Exception as e:
                print(f"[GW] parse error: {e}")


if __name__ == "__main__":
    if os.geteuid() != 0:
        print("[GW] WARNING: not running as root — pw file edits may fail")
    threading.Thread(target=discovery_loop, daemon=True).start()
    threading.Thread(target=mqtt_watcher_loop, daemon=True).start()
    print("[GW] Gateway running. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("[GW] Bye")
