#!/usr/bin/env python3
"""E2E Test: Verify OpenCode session is deleted when a project is deleted."""

import requests
import time
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
    log("=== E2E TEST: OpenCode session cleanup on project deletion ===\n")

    s = requests.Session()

    # 1. Login
    log("Step 1: Login")
    r = s.post(f"{BASE}/api/auth/login", json=CREDS)
    if r.status_code != 200:
        fail(f"Login failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Logged in as {r.json().get('username')}")

    # 2. Create a fresh project
    log("Step 2: Create project")
    r = s.post(f"{BASE}/api/projects", json={
        "name": "DeletionTest",
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

    # 3. Create an agent session
    log("Step 3: Create agent session")
    r = s.post(f"{BASE}/api/projects/{project_id}/agent/sessions")
    if r.status_code != 201:
        fail(f"Create session failed: {r.status_code} {r.text[:200]}")
    session = r.json()
    session_id = session["id"]
    log(f"  ✅ Agent session: {session_id[:12]}...")

    # 4. Send a message to create the OpenCode session
    log("Step 4: Send message to create OpenCode session")
    r = s.post(
        f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/messages",
        json={"content": "Just say hello. One sentence only. Do not use any tools."},
    )
    if r.status_code != 201:
        fail(f"Send message failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Message sent")

    # 5. Wait for completion and capture OpenCode session ID
    log("Step 5: Wait for message to complete")
    oc_session_id = None
    for i in range(90):
        time.sleep(2)
        r = s.get(f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}")
        data = r.json()
        status = data.get("status", "?")
        oc_id = data.get("opencodeSessionId")

        if i % 5 == 0:
            log(f"  ... status={status}, opencodeSessionId={oc_id}")

        if status == "completed" and oc_id:
            oc_session_id = oc_id
            break
        if status in ("failed", "cancelled"):
            fail(f"Message ended with status: {status}")

    if not oc_session_id:
        fail("Message never completed or no opencodeSessionId set")
    log(f"  ✅ Completed. OpenCode session: {oc_session_id}")

    # 6. Verify OpenCode session exists BEFORE deletion
    log("Step 6: Verify OpenCode session exists before deletion")
    r = requests.get(f"{OC_BASE}/session/{oc_session_id}")
    if r.status_code != 200:
        fail(f"OpenCode session not found before deletion: {r.status_code}")
    log(f"  ✅ OpenCode session exists (status {r.status_code})")

    # Also count total OpenCode sessions before
    r = requests.get(f"{OC_BASE}/session")
    oc_sessions_before = len(r.json())
    log(f"  Total OpenCode sessions before deletion: {oc_sessions_before}")

    # 7. Delete the project
    log("Step 7: Delete the project")
    r = s.delete(f"{BASE}/api/projects/{project_id}")
    if r.status_code != 204:
        fail(f"Delete project failed: {r.status_code} {r.text[:200]}")
    log(f"  ✅ Project deleted (status 204)")

    # 8. Verify project is gone from DB
    log("Step 8: Verify project is gone from AuroraCraft DB")
    r = s.get(f"{BASE}/api/projects/{project_id}")
    if r.status_code == 404:
        log(f"  ✅ Project not found in DB (404)")
    else:
        fail(f"Project still exists in DB: {r.status_code}")

    # 9. THE KEY CHECK: Is the OpenCode session also deleted?
    log("\n=== CRITICAL CHECK: OpenCode Session Cleanup ===")
    time.sleep(2)  # Give a moment for any async cleanup
    r = requests.get(f"{OC_BASE}/session/{oc_session_id}")
    oc_status = r.status_code

    r2 = requests.get(f"{OC_BASE}/session")
    oc_sessions_after = len(r2.json())

    log(f"  OpenCode session GET status: {oc_status}")
    log(f"  Total OpenCode sessions: {oc_sessions_before} -> {oc_sessions_after}")

    if oc_status == 404 or oc_status >= 400:
        log(f"  ✅ OpenCode session DELETED — cleanup works!")
    else:
        # Check if the session data is still there
        session_data = r.json()
        log(f"  ❌ OpenCode session STILL EXISTS (status {oc_status})")
        log(f"     Session ID: {session_data.get('id', '?')}")
        log(f"     Title: {session_data.get('title', '?')}")
        fail("OpenCode session was NOT cleaned up when project was deleted!")

    log("\n🎉 ALL TESTS PASSED — OpenCode session correctly deleted with project!")

if __name__ == "__main__":
    main()
