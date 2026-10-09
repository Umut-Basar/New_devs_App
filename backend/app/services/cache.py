import json
import redis.asyncio as redis
from typing import Dict, Any
import os

# Initialize Redis client with fast timeout to prevent blocking when Redis is unavailable.
redis_client = redis.Redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    socket_connect_timeout=0.2,
    socket_timeout=0.2
)

async def get_revenue_summary(property_id: str, tenant_id: str) -> Dict[str, Any]:
    """
    Fetches revenue summary, utilizing caching to improve performance.
    Ensures tenant isolation in the cache key and gracefully handles Redis outages.
    """
    cache_key = f"revenue:{tenant_id}:{property_id}"
    
    # Try to get from cache (gracefully handle Redis connection issues)
    try:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception as e:
        print(f"Redis cache get warning for {cache_key}: {e}")
    
    # Revenue calculation is delegated to the reservation service.
    from app.services.reservations import calculate_total_revenue
    
    # Calculate revenue
    result = await calculate_total_revenue(property_id, tenant_id)
    
    # Cache the result for 5 minutes (gracefully handle Redis connection issues)
    try:
        await redis_client.setex(cache_key, 300, json.dumps(result))
    except Exception as e:
        print(f"Redis cache set warning for {cache_key}: {e}")
    
    return result
