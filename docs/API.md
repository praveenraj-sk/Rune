# API Reference

All endpoints require an `x-api-key` header (except `/v1/health`).

---

## `POST /v1/can`

Check whether a subject can perform an action on an object.

**Request:**
```json
{
  "subject": "user:arjun",
  "action":  "read",
  "object":  "shipment:TN001"
}
```

**Response:**
```json
{
  "decision":      "allow",
  "status":        "ALLOW",
  "reason":        "Access granted — valid relationship found between user:arjun and shipment:TN001",
  "trace": [
    { "node": "user:arjun",             "result": "start" },
    { "node": "group:chennai_managers", "result": "connected" },
    { "node": "zone:chennai",           "result": "connected" },
    { "node": "shipment:TN001",         "result": "connected" }
  ],
  "suggested_fix": [],
  "cache_hit":     false,
  "latency_ms":    4.2,
  "sct":           { "lvn": 42 }
}
```

**Actions:** `read` | `edit` | `delete` | `manage`

**Status values:**

| Status | Meaning |
|---|---|
| `ALLOW` | Access granted |
| `DENY` | No valid relationship path found |
| `NOT_FOUND` | The object doesn't exist in the tuple store |

---

## `POST /v1/tuples`

Add a relationship.

```json
{ "subject": "user:alice", "relation": "viewer", "object": "doc:report" }
```

**Relations:** `owner` | `editor` | `viewer` | `member`

---

## `DELETE /v1/tuples`

Remove a relationship. Same body as POST.

---

## `GET /v1/logs`

Returns last 100 authorization decisions for your tenant.

---

## `GET /v1/health`

No auth required. Returns:

```json
{ "status": "ok", "db": "connected" }
```
