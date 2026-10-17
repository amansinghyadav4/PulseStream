"""Worker heartbeat healthcheck: exits 0 only if a fresh heartbeat exists in Redis.

Usage: python scripts/worker_healthcheck.py persistence
"""
import asyncio
import sys

from app.services.heartbeat import HEARTBEAT_TTL_S, read_heartbeat


async def main(name: str) -> int:
    status = await read_heartbeat(name)
    ok = status.get("status") == "healthy"
    print(f"worker={name} status={status.get('status')} ttl={status.get('heartbeat_ttl_s')}/{HEARTBEAT_TTL_S}")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: worker_healthcheck.py <persistence|analytics>")
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1])))
