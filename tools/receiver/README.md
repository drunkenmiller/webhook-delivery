# Test receiver

A fake customer endpoint for demos and end-to-end tests. It verifies
[Standard Webhooks](https://www.standardwebhooks.com/) signatures and can pretend to be a failing
or slow endpoint. No runtime dependencies (Node.js standard library only).

```bash
cd tools/receiver
WEBHOOK_SECRET=whsec_... npm start        # listens on :4000 (PORT to change)
```

`WEBHOOK_SECRET` takes one or more endpoint secrets separated by spaces. When it is empty,
signatures are **not** checked.

## Simulating endpoint behaviour

Any `POST` path receives webhooks. Behaviour is chosen with query parameters, so each endpoint
registered in the API can point to the same receiver with a different URL:

| Endpoint URL                                | Behaviour                                           |
| ------------------------------------------- | --------------------------------------------------- |
| `http://localhost:4000/ok`                  | `200`                                               |
| `http://localhost:4000/down?status=503`     | always `503`                                        |
| `http://localhost:4000/flaky?fail_rate=0.3` | `500` for ~30% of requests                          |
| `http://localhost:4000/slow?delay_ms=15000` | answers after 15 s (longer than the worker timeout) |

Invalid or missing signatures get `401`. Bodies over 1 MiB get `413`.

## Stats

`GET /stats` returns counters. `duplicates` counts webhook-ids that were acknowledged (2xx)
more than once, which is the visible cost of at-least-once delivery (ADR 0003):

```json
{ "received": 4, "rejected": 0, "failed": 1, "acknowledged": 3, "unique": 2, "duplicates": 1 }
```

Each request is also logged as one JSON line on stdout.
