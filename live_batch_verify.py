import asyncio, uuid
import httpx
BASE="http://127.0.0.1:8000"
async def test_batch():
    async with httpx.AsyncClient() as ac:
        r = await ac.post(f"{BASE}/api/v1/events/batch", json={"events": [
            {"event_type":"page.viewed","source":"live-batch","payload":{"a":1}},
            {"event_type":"page.viewed","source":"live-batch","payload":{"a":2}}
        ]})
        print(f"batch auto IDs -> {r.status_code}")
        assert r.status_code==201
        ids = [e["event_id"] for e in r.json()]
        print(f"batch ids: {ids}")
        assert len(set(ids))==2
        for eid in ids:
            gr = await ac.get(f"{BASE}/api/v1/events/{eid}")
            assert gr.status_code==200
        print("batch auto IDs PASS")
        dup_id = str(uuid.uuid4())
        r2 = await ac.post(f"{BASE}/api/v1/events/batch", json={"events": [
            {"event_id":dup_id,"event_type":"page.viewed","source":"live-batch","payload":{}},
            {"event_id":dup_id,"event_type":"page.viewed","source":"live-batch","payload":{}}
        ]})
        print(f"batch duplicate in-batch -> {r2.status_code} (expect 409)")
        assert r2.status_code==409
        print("batch duplicate in-batch PASS")
asyncio.run(test_batch())
