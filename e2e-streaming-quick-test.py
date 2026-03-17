#!/usr/bin/env python3
"""Quick E2E test for streaming fixes - uses a simple prompt for faster completion."""

import json, time, threading, requests, sys
try:
    import sseclient
except ImportError:
    print("Installing sseclient-py...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "sseclient-py", "-q"])
    import sseclient

BASE = "http://localhost:3000"
OC_BASE = "http://127.0.0.1:4096"

class SSEMonitor:
    def __init__(self):
        self.events = []
        self.event_types = set()
        self.text_count = 0
        self.thinking_count = 0
        self.file_op_count = 0
        self.complete_received = False
        self.running = True
        self.connected = False

    def monitor(self, url, cookies):
        try:
            resp = requests.get(url, stream=True, cookies=cookies, timeout=600)
            client = sseclient.SSEClient(resp)
            self.connected = True
            for event in client.events():
                if not self.running:
                    break
                try:
                    data = json.loads(event.data)
                    self.events.append(data)
                    etype = data.get("type", "?")
                    self.event_types.add(etype)
                    if etype == "text-delta": self.text_count += 1
                    elif etype == "thinking": self.thinking_count += 1
                    elif etype == "file-op": self.file_op_count += 1
                    elif etype == "complete": self.complete_received = True
                except: pass
        except Exception as e:
            if self.running:
                print(f"  SSE error: {e}")

    def stop(self):
        self.running = False

def login():
    s = requests.Session()
    r = s.post(f"{BASE}/api/auth/login", json={"login": "e2euser", "password": "testpass123"})
    assert r.status_code == 200, f"Login failed: {r.status_code}"
    return s

def wait_complete(s, pid, sid, timeout=600):
    start = time.time()
    while time.time() - start < timeout:
        r = s.get(f"{BASE}/api/projects/{pid}/agent/sessions/{sid}")
        if r.status_code == 200:
            d = r.json()
            status = d.get("status")
            msgs = [m for m in d.get("messages", []) if m["role"] == "agent"]
            if status in ("completed", "failed"):
                return status, msgs
        time.sleep(3)
    return "timeout", []

def main():
    print("=" * 50)
    print("Quick Streaming Fix Verification")
    print("=" * 50)

    # Verify services
    try:
        r = requests.get(f"{OC_BASE}/session", timeout=5)
        print(f"✅ OpenCode: {len(r.json())} sessions")
    except:
        print("❌ OpenCode not running"); sys.exit(1)

    r = requests.get(f"{BASE}/api/health", timeout=5)
    assert r.status_code == 200, "Server not running"
    print("✅ Server healthy")

    s = login()
    print("✅ Logged in")

    # Get or create project
    projects = s.get(f"{BASE}/api/projects").json()
    if projects:
        pid = projects[0]["id"]
    else:
        r = s.post(f"{BASE}/api/projects", json={"name":"StreamTest","software":"paper","language":"java","javaVersion":"21","compiler":"gradle"})
        pid = r.json()["id"]

    # Create session
    sid = s.post(f"{BASE}/api/projects/{pid}/agent/sessions").json()["id"]
    stream_url = f"{BASE}/api/projects/{pid}/agent/sessions/{sid}/stream"

    # ── Test 1: Simple prompt with SSE monitoring ──
    print("\n── Test 1: Simple prompt ──")
    mon = SSEMonitor()
    t = threading.Thread(target=mon.monitor, args=(stream_url, s.cookies.get_dict()), daemon=True)
    t.start()
    time.sleep(2)
    print(f"  SSE connected: {mon.connected}")

    # Simple prompt that should complete quickly
    msg = s.post(f"{BASE}/api/projects/{pid}/agent/sessions/{sid}/messages",
                 json={"content": "Just say hello and explain what AuroraCraft is in 2 sentences. Do not create any files.",
                        "model": "opencode/minimax-m2.5-free"})
    assert msg.status_code in (200, 201), f"Send failed: {msg.status_code}"
    print(f"  Message sent, waiting for completion...")

    status1, msgs1 = wait_complete(s, pid, sid, timeout=600)
    time.sleep(3)
    mon.stop()

    print(f"  Status: {status1}")
    print(f"  SSE events: {len(mon.events)} (types: {sorted(mon.event_types)})")
    print(f"  Text: {mon.text_count}, Thinking: {mon.thinking_count}, FileOps: {mon.file_op_count}")
    print(f"  Complete received: {mon.complete_received}")
    print(f"  Agent msgs: {len(msgs1)}")

    t1_events = len(mon.events) > 2
    t1_content = mon.text_count > 0 or mon.thinking_count > 0
    t1_complete = status1 == "completed"
    t1_response = len(msgs1) > 0

    print(f"  {'✅' if t1_events else '❌'} Events flowed ({len(mon.events)})")
    print(f"  {'✅' if t1_content else '❌'} Content received")
    print(f"  {'✅' if t1_complete else '❌'} Session completed ({status1})")
    print(f"  {'✅' if t1_response else '❌'} Response saved")

    # ── Test 2: 2nd message (pollUntilIdle baseline) ──
    if t1_complete:
        print("\n── Test 2: 2nd message in same session ──")
        mon2 = SSEMonitor()
        t2 = threading.Thread(target=mon2.monitor, args=(stream_url, s.cookies.get_dict()), daemon=True)
        t2.start()
        time.sleep(2)

        msg2 = s.post(f"{BASE}/api/projects/{pid}/agent/sessions/{sid}/messages",
                      json={"content": "Now say goodbye in one sentence. Do not create any files.",
                             "model": "opencode/minimax-m2.5-free"})
        if msg2.status_code in (200, 201):
            print(f"  2nd message sent, waiting...")
            status2, msgs2 = wait_complete(s, pid, sid, timeout=600)
            time.sleep(3)
            mon2.stop()

            print(f"  Status: {status2}")
            print(f"  SSE events: {len(mon2.events)} (types: {sorted(mon2.event_types)})")
            print(f"  Agent msgs total: {len(msgs2)}")

            t2_events = len(mon2.events) > 2
            t2_complete = status2 == "completed"
            t2_new_msg = len(msgs2) >= 2

            print(f"  {'✅' if t2_events else '❌'} 2nd message got events")
            print(f"  {'✅' if t2_complete else '❌'} 2nd message completed ({status2})")
            print(f"  {'✅' if t2_new_msg else '❌'} New response saved ({len(msgs2)} agent msgs)")
        else:
            print(f"  ⚠️ Could not send 2nd msg: {msg2.status_code} {msg2.text[:100]}")
            t2_events = t2_complete = t2_new_msg = False

    # Summary
    print("\n" + "=" * 50)
    all_ok = t1_events and t1_content and t1_complete and t1_response
    if t1_complete:
        all_ok = all_ok and t2_events and t2_complete and t2_new_msg
    print("🎉 ALL TESTS PASSED!" if all_ok else "⚠️ SOME TESTS FAILED")
    print("=" * 50)

if __name__ == "__main__":
    main()
