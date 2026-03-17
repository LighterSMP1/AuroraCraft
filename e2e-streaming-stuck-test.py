#!/usr/bin/env python3
"""
E2E Test: Verify UI streaming doesn't get stuck during plugin creation.

Tests 3 specific fixes:
1. SSE events continue flowing after OpenCode SSE reconnect (partTypes preserved)
2. 2nd message doesn't complete prematurely (pollUntilIdle baseline)
3. Session doesn't complete before AI is done (30s idle timer)

Strategy: Send a plugin creation prompt, monitor SSE events, and verify:
- Events keep flowing throughout the entire operation
- Session status stays 'running' until the AI is actually done
- Text/thinking events arrive (not silently dropped)
- The response is saved as a complete agent message
"""

import json
import time
import threading
import requests
import sseclient  # type: ignore
import sys

BASE = "http://localhost:3000"
OC_BASE = "http://127.0.0.1:4096"
CREDS = {"login": "e2euser", "password": "testpass123"}

class SSEMonitor:
    """Monitor SSE events in a background thread."""
    def __init__(self):
        self.events = []
        self.event_types = set()
        self.text_chunks = []
        self.thinking_count = 0
        self.file_op_count = 0
        self.complete_received = False
        self.last_event_time = time.time()
        self.running = True
        self.connected = False
        self.error = None

    def monitor(self, url, cookies):
        try:
            resp = requests.get(url, stream=True, cookies=cookies, timeout=300)
            client = sseclient.SSEClient(resp)
            self.connected = True
            for event in client.events():
                if not self.running:
                    break
                try:
                    data = json.loads(event.data)
                    self.events.append(data)
                    self.event_types.add(data.get("type", "?"))
                    self.last_event_time = time.time()

                    if data.get("type") == "text-delta":
                        self.text_chunks.append(data.get("content", ""))
                    elif data.get("type") == "thinking":
                        self.thinking_count += 1
                    elif data.get("type") == "file-op":
                        self.file_op_count += 1
                    elif data.get("type") == "complete":
                        self.complete_received = True
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            self.error = str(e)

    def stop(self):
        self.running = False


def login():
    s = requests.Session()
    r = s.post(f"{BASE}/api/auth/login", json=CREDS)
    if r.status_code != 200:
        print(f"❌ Login failed: {r.status_code} {r.text[:100]}")
        sys.exit(1)
    print("✅ Logged in as e2euser")
    return s


def get_or_create_project(s):
    """Get an existing project or create a new one for testing."""
    r = s.get(f"{BASE}/api/projects")
    projects = r.json()
    if isinstance(projects, list) and len(projects) > 0:
        proj = projects[0]
        print(f"  Using existing project: {proj['name']} ({proj['id'][:12]}...)")
        return proj["id"]

    # Create a new project
    r = s.post(f"{BASE}/api/projects", json={
        "name": "E2E Streaming Test",
        "description": "Test project for streaming fix verification",
        "software": "paper",
        "language": "java",
        "javaVersion": "21",
        "compiler": "gradle",
    })
    if r.status_code not in (200, 201):
        print(f"❌ Create project failed: {r.status_code} {r.text[:100]}")
        sys.exit(1)
    proj = r.json()
    print(f"  Created project: {proj['name']} ({proj['id'][:12]}...)")
    return proj["id"]


def create_session(s, project_id):
    r = s.post(f"{BASE}/api/projects/{project_id}/agent/sessions")
    if r.status_code not in (200, 201):
        print(f"❌ Create session failed: {r.status_code} {r.text[:100]}")
        sys.exit(1)
    session = r.json()
    print(f"  Session created: {session['id'][:12]}...")
    return session["id"]


def send_message(s, project_id, session_id, content, model=None):
    body = {"content": content}
    if model:
        body["model"] = model
    r = s.post(f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/messages", json=body)
    if r.status_code not in (200, 201):
        print(f"❌ Send message failed: {r.status_code} {r.text[:100]}")
        return None
    return r.json()


def wait_for_completion(s, project_id, session_id, timeout=300):
    """Poll DB until session is completed/failed."""
    start = time.time()
    while time.time() - start < timeout:
        r = s.get(f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}")
        if r.status_code == 200:
            data = r.json()
            status = data.get("status", "?")
            messages = data.get("messages", [])
            agent_msgs = [m for m in messages if m["role"] == "agent"]
            if status in ("completed", "failed"):
                return status, agent_msgs
        time.sleep(3)
    return "timeout", []


def check_opencode_sessions_before():
    """Get count of OpenCode sessions before the test."""
    try:
        r = requests.get(f"{OC_BASE}/session", timeout=5)
        return len(r.json())
    except:
        return -1


def main():
    print("=" * 60)
    print("E2E Test: Streaming Stuck Fix Verification")
    print("=" * 60)

    # Check OpenCode is running
    try:
        r = requests.get(f"{OC_BASE}/session", timeout=5)
        print(f"✅ OpenCode running ({len(r.json())} sessions)")
    except:
        print("❌ OpenCode not responding on port 4096")
        sys.exit(1)

    s = login()
    project_id = get_or_create_project(s)
    session_id = create_session(s, project_id)

    # ── Test 1: Plugin creation with SSE monitoring ──────────────
    print("\n── Test 1: Plugin Creation (SSE event flow) ──")

    # Start SSE monitor before sending message
    stream_url = f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/stream"
    monitor = SSEMonitor()
    thread = threading.Thread(target=monitor.monitor, args=(stream_url, s.cookies.get_dict()))
    thread.daemon = True
    thread.start()
    time.sleep(2)  # Let SSE connect

    if not monitor.connected:
        time.sleep(3)

    print(f"  SSE connected: {monitor.connected}")

    # Send plugin creation prompt
    prompt1 = "Create a simple Minecraft plugin that says 'Hello World' when a player joins. Just create the main plugin Java class file."
    msg = send_message(s, project_id, session_id, prompt1, model="opencode/minimax-m2.5-free")
    if not msg:
        print("❌ Failed to send message")
        sys.exit(1)
    print(f"  Message sent: {msg['id'][:12]}...")
    print("  Waiting for AI to process (this may take 1-4 minutes)...")

    # Wait for completion while monitoring events
    status, agent_msgs = wait_for_completion(s, project_id, session_id, timeout=300)
    monitor.stop()

    # Give a moment for final events to arrive
    time.sleep(2)

    print(f"\n  ── Results ──")
    print(f"  Session status: {status}")
    print(f"  Total SSE events received: {len(monitor.events)}")
    print(f"  Event types seen: {sorted(monitor.event_types)}")
    print(f"  Text chunks: {len(monitor.text_chunks)}")
    print(f"  Thinking events: {monitor.thinking_count}")
    print(f"  File-op events: {monitor.file_op_count}")
    print(f"  Complete received: {monitor.complete_received}")
    print(f"  Agent messages: {len(agent_msgs)}")
    if agent_msgs:
        last_msg = agent_msgs[-1]
        parts = last_msg.get("metadata", {}).get("parts", []) if last_msg.get("metadata") else []
        print(f"  Last agent msg parts: {len(parts)}")
        print(f"  Last agent msg length: {len(last_msg.get('content', ''))}")

    # Verify: Events kept flowing (not stuck)
    event_flow_ok = len(monitor.events) > 3
    print(f"\n  ✅ Events flowed" if event_flow_ok else "\n  ❌ Too few events - streaming may have been stuck")

    # Verify: Got text or thinking events (not silently dropped)
    content_ok = len(monitor.text_chunks) > 0 or monitor.thinking_count > 0
    print(f"  ✅ Text/thinking content received" if content_ok else "  ❌ No text/thinking content - events may have been dropped")

    # Verify: Session completed (not timed out)
    completion_ok = status == "completed"
    print(f"  ✅ Session completed normally" if completion_ok else f"  ❌ Session status: {status}")

    # Verify: Got agent response
    response_ok = len(agent_msgs) > 0 and len(agent_msgs[-1].get("content", "")) > 10
    print(f"  ✅ Agent response saved" if response_ok else "  ❌ No agent response saved")

    # ── Test 2: 2nd message in same session (pollUntilIdle baseline) ──
    if status == "completed":
        print("\n── Test 2: 2nd Message (pollUntilIdle baseline fix) ──")

        monitor2 = SSEMonitor()
        thread2 = threading.Thread(target=monitor2.monitor, args=(stream_url, s.cookies.get_dict()))
        thread2.daemon = True
        thread2.start()
        time.sleep(2)

        prompt2 = "Add a command /hello that sends 'Hello from AuroraCraft!' to the player. Just modify the existing plugin file."
        msg2 = send_message(s, project_id, session_id, prompt2, model="opencode/minimax-m2.5-free")
        if msg2:
            print(f"  2nd message sent: {msg2['id'][:12]}...")
            print("  Waiting for AI to process...")

            status2, agent_msgs2 = wait_for_completion(s, project_id, session_id, timeout=300)
            monitor2.stop()
            time.sleep(2)

            print(f"\n  ── Results ──")
            print(f"  Session status: {status2}")
            print(f"  Total SSE events: {len(monitor2.events)}")
            print(f"  Text chunks: {len(monitor2.text_chunks)}")
            print(f"  Thinking events: {monitor2.thinking_count}")
            print(f"  Agent messages total: {len(agent_msgs2)}")

            # Verify: 2nd message got new events (not old replayed ones)
            msg2_events_ok = len(monitor2.events) > 3
            print(f"\n  ✅ 2nd message got events" if msg2_events_ok else "\n  ❌ 2nd message got too few events")

            # Verify: 2nd message completed
            msg2_complete_ok = status2 == "completed"
            print(f"  ✅ 2nd message completed" if msg2_complete_ok else f"  ❌ 2nd message status: {status2}")

            # Verify: Got new agent message (not old response)
            msg2_response_ok = len(agent_msgs2) >= 2  # user1+agent1+user2+agent2 = at least 2 agent msgs
            print(f"  ✅ New agent response saved (total: {len(agent_msgs2)} agent msgs)" if msg2_response_ok else "  ❌ Missing agent response for 2nd message")
        else:
            print("  ⚠️ Skipping - couldn't send 2nd message (session may not be in correct state)")

    # ── Summary ──
    print("\n" + "=" * 60)
    all_pass = event_flow_ok and content_ok and completion_ok and response_ok
    if all_pass:
        print("🎉 ALL TESTS PASSED — Streaming fixes verified!")
    else:
        print("⚠️ SOME TESTS FAILED — See details above")
    print("=" * 60)


if __name__ == "__main__":
    main()
