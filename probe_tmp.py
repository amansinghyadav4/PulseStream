import json
import subprocess
import uuid

BASE = "http://localhost:8000"
TMP = "probe_tmp.json"
DATA = "probe_data.json"


def req(method, path, data=None, headers=None):
    cmd = ["curl", "-s", "-X", method, f"{BASE}{path}", "-o", TMP, "-w", "%{http_code}"]
    if data is not None:
        with open(DATA, "w", encoding="utf-8") as f:
            f.write(data)
        cmd += ["-H", "Content-Type: application/json", "--data-binary", f"@{DATA}"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    code = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    try:
        with open(TMP, encoding="utf-8") as f:
            body = json.load(f)
    except Exception:
        body = None
    return int(code), body


results = []

# --- 6. batch with already-existing event_id (expect 409) ---
dup_event = {
    "event_id": "11111111-1111-4111-8111-111111111111",
    "event_type": "user.login",
    "source": "batch",
    "user_id": "u-dup",
    "payload": {},
}
req("POST", "/events", json.dumps(dup_event))
code, body = req("POST", "/events/batch", json.dumps({"events": [dup_event]}))
results.append(("6. batch duplicate event_id -> 409", code == 409, code, str(body)[:200]))

# --- 7. batch exceeding max size (expect 422) ---
big_batch = [
    {
        "event_id": f"22222222-{i:04d}-4222-8222-{i:012d}",
        "event_type": "test.bulk",
        "source": "batch",
        "payload": {},
    }
    for i in range(1001)
]
code, body = req("POST", "/events/batch", json.dumps({"events": big_batch}))
results.append(("7. batch > max_batch_size (1001) -> 422", code == 422, code, str(body)[:200]))

# --- 8. GET nonexistent id (expect 404) ---
code, body = req("GET", "/events/99999999-9999-4999-8999-999999999999")
results.append(("8. GET missing id -> 404", code == 404, code, str(body)[:200]))

# --- 9. malformed JSON body (expect 422 or 400) ---
cmd = ["curl", "-s", "-X", "POST", f"{BASE}/events", "-o", TMP,
       "-w", "%{http_code}", "-H", "Content-Type: application/json",
       "--data-binary", "{not json"]
code = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
results.append(("9. malformed JSON -> 4xx", code in ("400", "422"), code, ""))

# --- 10. CORS preflight ---
code, _ = req("OPTIONS", "/events", headers={
    "Origin": "http://localhost:3000",
    "Access-Control-Request-Method": "POST",
})
results.append(("10. CORS preflight from allowed origin -> 2xx/3xx", 200 <= code < 400, code, ""))

print("\n".join(f"[{'PASS' if ok else 'FAIL'}] {name} | got={got} | {extra}"
                for name, ok, got, extra in results))
