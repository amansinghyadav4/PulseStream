import asyncio, json, uuid
from aiokafka import AIOKafkaProducer, AIOKafkaConsumer

async def produce_malformed():
    producer = AIOKafkaProducer(bootstrap_servers="localhost:9092")
    await producer.start()
    try:
        await producer.send_and_wait("application-events", value=b"not json malformed live", key=b"test-malformed")
        print("produced malformed to application-events")
    finally:
        await producer.stop()

async def consume_dlq():
    consumer = AIOKafkaConsumer(
        "dead-letter-events",
        bootstrap_servers="localhost:9092",
        group_id=f"dlq-verify-{uuid.uuid4()}",
        auto_offset_reset="earliest",
        enable_auto_commit=True,
        consumer_timeout_ms=5000,
    )
    await consumer.start()
    try:
        found = False
        async for msg in consumer:
            print(f"DLQ msg key={msg.key} value={msg.value[:200]}")
            if b"not json" in msg.value or b"malformed" in msg.value:
                found = True
                print("DLQ contains malformed original")
                break
        if not found:
            # try polling with timeout
            print("no DLQ found after 5s - may need more time, checking via kafka-topics")
        return found
    finally:
        await consumer.stop()

async def main():
    await produce_malformed()
    print("waiting 3s for worker to DLQ...")
    await asyncio.sleep(3)
    found = await consume_dlq()
    print(f"DLQ found={found}")

asyncio.run(main())
