import json
import uuid
import urllib.error
import urllib.request

BASE = "http://localhost:8000"
EXISTING_ID = "d7a2ba21-c633-4982-b2c1-628e76454225"


def call(method, path, body=None, headers=None):
    req = urllib.request.Request(
        BASE + path, method=method, data=body, headers=headers or {}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(), dict(exc.headers)


def show(title, status, body, extra=""):
    print(f"== {title} ==")
    print(status)
    print(body[:300])
    if extra:
        print(extra)


batch_dup = {
    "events": [
        {"event_id": EXISTING_ID, "event_type": "user.login", "source": "web-app"},
        {"event_type": "user.logout", "source": "web-app"},
    ]
}
s, b, _ = call("POST", "/events/batch", json.dumps(batch_dup).encode(), {"Content-Type": "application/json"})
show("6. batch w/ existing id (expect 409)", s, b)

big_batch = {"events": [{"event_type": "probe.tick", "source": "probe"}] * 1001}
s, b, _ = call("POST", "/events/batch", json.dumps(big_batch).encode(), {"Content-Type": "application/json"})
show("7. batch of 1001 (expect 422)", s, b)

huge_raw = json.dumps(
    {"event_type": "probe.big", "source": "probe", "payload": {"blob": "x" * (1048576 + 1024)}}
).encode()
s, b, _ = call("POST", "/events", huge_raw, {"Content-Type": "application/json"})
show(f"8. oversize body {len(huge_raw)} bytes (expect 413)", s, b)

s, b, _ = call("GET", f"/events/{uuid.uuid4()}")
show("9. get missing id (expect 404)", s, b)

s, b, h = call(
    "OPTIONS",
    "/events",
    None,
    {"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"},
)
cors = {k: v for k, v in h.items() if "access-control" in k.lower()}
show("10. CORS preflight", s, b, extra=str(cors))
