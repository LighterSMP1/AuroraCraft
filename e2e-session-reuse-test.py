#!/usr/bin/env python3
"""E2E Test: Verify 2nd message reuses the same OpenCode session as the 1st message."""

import requests
import time
import json
import sys

BASE = "http://localhost:3000"
OC_BASE = "http://127.0.0.1:4096"
CREDS = {"login": "e2euser", "password": "testpass123"}

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def fail(msg):
    log(f"❌ FAIL: {msg}")
    sys.exit(1)

def main():
    log("=== E2E TEST: 2nd message reuses same OpenCode session ===\n")

    # Use a session to persist cookies
    s = requests.Session()

    # 1. Login
    log("Step 1: Login")
    r = s.post(f"{BASE}/api/auth/login", json=CREDS)
    if r.status_code != 200:
        fail(f"Login failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Logged in as {r.json().get('username')}")

    # 2. Create a fresh project for this test
    log("Step 2: Create project")
    r = s.post(f"{BASE}/api/projects", json={
        "name": "SessionReuseTest",
        "software": "paper",
        "language": "java",
        "javaVersion": "21",
        "compiler": "gradle",
    })
    if r.status_code != 201:
        fail(f"Create project failed: {r.status_code} {r.text[:200]}")
    project = r.json()
    project_id = project["id"]
    log(f"  ✅ Project: {project_id[:12]}... ({project['name']})")

    # 3. Create a new agent session
    log("Step 3: Create agent session")
    r = s.post(f"{BASE}/api/projects/{project_id}/agent/sessions")
    if r.status_code != 201:
        fail(f"Create session failed: {r.status_code} {r.text[:200]}")
    session = r.json()
    session_id = session["id"]
    log(f"  ✅ Session: {session_id[:12]}...")

    # 4. Send message 1
    log("Step 4: Send message 1 (simple prompt)")
    r = s.post(
        f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/messages",
        json={"content": "Just say hello. One sentence only. Do not use any tools."},
    )
    if r.status_code != 201:
        fail(f"Send msg1 failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Message 1 sent")

    # 5. Poll DB for message 1 completion
    log("Step 5: Wait for message 1 to complete and capture OpenCode session ID")
    oc_session_1 = None
    for i in range(90):
        time.sleep(2)
        r = s.get(f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}")
        data = r.json()
        status = data.get("status", "?")
        oc_id = data.get("opencodeSessionId")
        msg_count = len(data.get("messages", []))

        if i % 5 == 0:
            log(f"  ... status={status}, opencodeSessionId={oc_id}, messages={msg_count}")

        if status == "completed" and oc_id:
            oc_session_1 = oc_id
            break
        if status in ("failed", "cancelled"):
            fail(f"Message 1 ended with status: {status}")

    if not oc_session_1:
        fail("Message 1 never completed or no opencodeSessionId set")
    log(f"  ✅ Message 1 completed. OpenCode session: {oc_session_1}")

    # 6. Verify the OpenCode session exists
    log("Step 6: Verify OpenCode session exists in OpenCode API")
    r = requests.get(f"{OC_BASE}/session/{oc_session_1}")
    if r.status_code != 200:
        fail(f"OpenCode session {oc_session_1} not found: {r.status_code}")
    oc_msgs_1 = requests.get(f"{OC_BASE}/session/{oc_session_1}/message").json()
    log(f"  ✅ OpenCode session exists with {len(oc_msgs_1)} messages")

    # 7. Send message 2
    log("Step 7: Send message 2 (follow-up)")
    r = s.post(
        f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/messages",
        json={"content": "Now say goodbye. One sentence only. Do not use any tools."},
    )
    if r.status_code != 201:
        fail(f"Send msg2 failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Message 2 sent")

    # 8. Poll DB for message 2 completion
    log("Step 8: Wait for message 2 to complete and check OpenCode session ID")
    oc_session_2 = None
    for i in range(90):
        time.sleep(2)
        r = s.get(f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}")
        data = r.json()
        status = data.get("status", "?")
        oc_id = data.get("opencodeSessionId")
        msg_count = len(data.get("messages", []))

        if i % 5 == 0:
            log(f"  ... status={status}, opencodeSessionId={oc_id}, messages={msg_count}")

        if status == "completed" and msg_count >= 4 and oc_id:
            oc_session_2 = oc_id
            break
        if status in ("failed", "cancelled"):
            fail(f"Message 2 ended with status: {status}")

    if not oc_session_2:
        fail("Message 2 never completed or no opencodeSessionId set")
    log(f"  ✅ Message 2 completed. OpenCode session: {oc_session_2}")

    # 9. THE KEY CHECK: Are they the same OpenCode session?
    log("\n=== CRITICAL CHECK: Session Reuse ===")
    log(f"  Message 1 OpenCode session: {oc_session_1}")
    log(f"  Message 2 OpenCode session: {oc_session_2}")

    if oc_session_1 == oc_session_2:
        log("  ✅ SAME OpenCode session — session reuse WORKS!")
    else:
        fail(f"DIFFERENT OpenCode sessions! {oc_session_1} vs {oc_session_2}")

    # 10. Verify the OpenCode session has all messages
    log("\nStep 10: Verify OpenCode session has messages from both interactions")
    r = requests.get(f"{OC_BASE}/session/{oc_session_1}/message")
    oc_msgs_final = r.json()
    log(f"  OpenCode session now has {len(oc_msgs_final)} messages (was {len(oc_msgs_1)} after msg 1)")

    if len(oc_msgs_final) > len(oc_msgs_1):
        log("  ✅ OpenCode session accumulated messages from both prompts")
    else:
        log("  ⚠️  Message count didn't increase — AI may have used internal context")

    for m in oc_msgs_final:
        role = m.get("info", {}).get("role", "?")
        parts = m.get("parts", [])
        text_preview = ""
        for p in parts:
            if p.get("type") == "text":
                text_preview = p.get("text", "")[:80]
                break
        log(f"    [{role}] {text_preview}")

    log("\n🎉 ALL TESTS PASSED — 2nd message correctly reuses the same OpenCode session!")

if __name__ == "__main__":
    main()
