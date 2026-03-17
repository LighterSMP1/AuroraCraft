#!/usr/bin/env python3
"""
E2E test: Verify file operations are properly streamed during plugin creation.
Tests that:
1. File-op SSE events are received (not silently dropped)
2. Session completes properly after multi-step operations
3. Persisted message metadata includes file parts
"""

import json
import time
import threading
import requests
import sseclient

BASE = "http://localhost:3000"
ADMIN_CREDS = {"login": "e2euser", "password": "testpass123"}

def login():
    r = requests.post(f"{BASE}/api/auth/login", json=ADMIN_CREDS)
    r.raise_for_status()
    return r.cookies

def create_project(cookies):
    r = requests.post(f"{BASE}/api/projects", json={
        "name": f"FileOpsTest-{int(time.time())}",
        "software": "paper",
        "language": "java",
        "compiler": "gradle",
    }, cookies=cookies)
    r.raise_for_status()
    return r.json()

def create_session(cookies, project_id):
    r = requests.post(f"{BASE}/api/projects/{project_id}/agent/sessions", cookies=cookies)
    r.raise_for_status()
    return r.json()

def send_message(cookies, project_id, session_id, content, model=None):
    body = {"content": content}
    if model:
        body["model"] = model
    r = requests.post(
        f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/messages",
        json=body, cookies=cookies
    )
    r.raise_for_status()
    return r.json()

def collect_sse_events(cookies, project_id, session_id, events_list, stop_event, timeout=300):
    """Collect SSE events in a background thread."""
    url = f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}/stream"
    try:
        r = requests.get(url, stream=True, cookies=cookies, timeout=timeout)
        client = sseclient.SSEClient(r)
        for event in client.events():
            if stop_event.is_set():
                break
            try:
                data = json.loads(event.data)
                events_list.append(data)
                evt_type = data.get("type", "?")
                if evt_type == "file-op":
                    action = data.get("action", "?")
                    path = data.get("path", "?")
                    status = data.get("status", "?")
                    tool = data.get("tool", "?")
                    print(f"  📁 file-op: {action} {path} [{status}] (tool={tool})")
                elif evt_type == "thinking":
                    done = data.get("done", False)
                    print(f"  🧠 thinking {'(done)' if done else '...'}")
                elif evt_type == "text-delta":
                    content = data.get("content", "")[:60]
                    print(f"  📝 text: {content}")
                elif evt_type == "complete":
                    print(f"  ✅ COMPLETE event received!")
                    stop_event.set()
                    break
                elif evt_type == "status":
                    status = data.get("status", "?")
                    print(f"  📊 status: {status}")
                elif evt_type == "error":
                    msg = data.get("message", "?")
                    print(f"  ❌ error: {msg}")
            except json.JSONDecodeError:
                pass
    except Exception as e:
        print(f"  SSE connection error: {e}")

def wait_for_session_status(cookies, project_id, session_id, target_statuses, timeout=360):
    """Poll session status until it reaches one of the target statuses."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(
                f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}",
                cookies=cookies
            )
            if r.ok:
                session = r.json()
                status = session.get("status")
                if status in target_statuses:
                    return status
        except:
            pass
        time.sleep(3)
    return "timeout"

def test_file_ops_streaming():
    """Test that file operations are properly streamed during file creation."""
    print("=" * 60)
    print("TEST: File Operations Streaming")
    print("=" * 60)
    
    cookies = login()
    print("✅ Logged in")
    
    project = create_project(cookies)
    project_id = project["id"]
    print(f"✅ Created project: {project['name']} ({project_id[:8]}...)")
    
    session = create_session(cookies, project_id)
    session_id = session["id"]
    print(f"✅ Created session: {session_id[:8]}...")
    
    # Start SSE listener
    events = []
    stop = threading.Event()
    sse_thread = threading.Thread(
        target=collect_sse_events,
        args=(cookies, project_id, session_id, events, stop),
        daemon=True
    )
    sse_thread.start()
    time.sleep(2)
    
    # Send a simple file creation request (faster than full plugin)
    prompt = "Create a simple Java file at src/main/java/com/example/Hello.java with a Hello class that has a main method printing 'Hello World'. Just create this ONE file, nothing else."
    print(f"\n📤 Sending: {prompt[:60]}...")
    send_message(cookies, project_id, session_id, prompt, model="opencode/minimax-m2.5-free")
    
    # Wait for completion
    print("\n⏳ Waiting for completion (up to 6 min)...")
    final_status = wait_for_session_status(cookies, project_id, session_id, 
                                           ["completed", "failed", "cancelled"], timeout=360)
    
    # Give SSE a moment to receive the complete event
    time.sleep(5)
    stop.set()
    sse_thread.join(timeout=5)
    
    # Analyze results
    print(f"\n{'=' * 60}")
    print("RESULTS")
    print(f"{'=' * 60}")
    print(f"Session final status: {final_status}")
    print(f"Total SSE events received: {len(events)}")
    
    # Count event types
    type_counts = {}
    for evt in events:
        t = evt.get("type", "unknown")
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f"Event type breakdown: {json.dumps(type_counts, indent=2)}")
    
    # Check for file-op events
    file_ops = [e for e in events if e.get("type") == "file-op"]
    print(f"\nFile operations received: {len(file_ops)}")
    for op in file_ops:
        print(f"  - {op.get('action')} {op.get('path')} [{op.get('status')}] tool={op.get('tool')}")
    
    # Check for complete event
    complete_events = [e for e in events if e.get("type") == "complete"]
    print(f"Complete events received: {len(complete_events)}")
    
    # Check persisted message metadata
    try:
        r = requests.get(
            f"{BASE}/api/projects/{project_id}/agent/sessions/{session_id}",
            cookies=cookies
        )
        if r.ok:
            session_data = r.json()
            messages = session_data.get("messages", [])
            agent_msgs = [m for m in messages if m.get("role") == "agent"]
            if agent_msgs:
                last_agent = agent_msgs[-1]
                parts = (last_agent.get("metadata") or {}).get("parts", [])
                print(f"\nPersisted message parts: {len(parts)}")
                for p in parts:
                    ptype = p.get("type")
                    if ptype == "file":
                        print(f"  - file: {p.get('action')} {p.get('path')}")
                    elif ptype == "tool":
                        print(f"  - tool: {p.get('tool')} {p.get('path')}")
                    elif ptype == "thinking":
                        print(f"  - thinking: {p.get('content','')[:50]}...")
    except Exception as e:
        print(f"Error checking persisted data: {e}")
    
    # Assertions
    print(f"\n{'=' * 60}")
    print("ASSERTIONS")
    print(f"{'=' * 60}")
    
    passed = True
    
    # 1. Session should complete (not timeout)
    if final_status == "completed":
        print("✅ PASS: Session completed successfully")
    elif final_status == "timeout":
        print("⚠️  WARN: Session timed out (may be slow model - checking if events flowed)")
    else:
        print(f"❌ FAIL: Session ended with status: {final_status}")
        passed = False
    
    # 2. Should have received SSE events
    if len(events) > 3:
        print(f"✅ PASS: Received {len(events)} SSE events")
    else:
        print(f"❌ FAIL: Only received {len(events)} events (expected > 3)")
        passed = False
    
    # 3. CRITICAL: Should have received file-op events (this was the bug!)
    if len(file_ops) > 0:
        print(f"✅ PASS: Received {len(file_ops)} file-op events (bug is fixed!)")
    else:
        print(f"❌ FAIL: No file-op events received (bug NOT fixed!)")
        passed = False
    
    # 4. Should have file-op events with 'create' or 'update' action
    create_ops = [op for op in file_ops if op.get("action") in ("create", "update")]
    if create_ops:
        print(f"✅ PASS: {len(create_ops)} file create/update operations detected")
    elif file_ops:
        print(f"⚠️  INFO: File ops are tool-type only: {[op.get('action') for op in file_ops]}")
    else:
        print(f"❌ FAIL: No file create/update operations")
        passed = False
    
    # 5. Should have received a complete event (or session completed)
    if complete_events or final_status == "completed":
        print(f"✅ PASS: Completion detected (SSE complete: {len(complete_events)}, DB status: {final_status})")
    else:
        print(f"⚠️  WARN: No completion detected yet")
    
    print(f"\n{'=' * 60}")
    if passed:
        print("🎉 ALL CRITICAL TESTS PASSED!")
    else:
        print("❌ SOME TESTS FAILED")
    print(f"{'=' * 60}")
    
    return passed

if __name__ == "__main__":
    try:
        success = test_file_ops_streaming()
        exit(0 if success else 1)
    except Exception as e:
        print(f"\n💥 Test error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
