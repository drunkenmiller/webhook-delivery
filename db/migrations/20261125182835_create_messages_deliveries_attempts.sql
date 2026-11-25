-- migrate:up

-- Composite foreign keys below ("this delivery's endpoint belongs to the same application as its
-- message") need a UNIQUE (app_id, id) to point at. It replaces the plain (app_id, id) index of
-- the first migration: same columns, same order, so cursor pagination keeps using it.
ALTER TABLE endpoints ADD CONSTRAINT endpoints_app_id_id_key UNIQUE (app_id, id);
DROP INDEX endpoints_app_id_id_idx;

-- One row per event submitted with POST /v1/messages. `id` is sent as the `webhook-id` header,
-- identical across retries, so receivers can deduplicate (ADR 0003).
CREATE TABLE messages (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    app_id          uuid        NOT NULL REFERENCES applications (id),
    event_type      text        NOT NULL CHECK (event_type ~ '^[a-z0-9_.-]{1,64}$'),
    payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    -- Idempotency (SPEC §6): a retried request with the same key returns the original message.
    idempotency_key text        NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    -- SHA-256 of the canonical request body: same key + different body → 422.
    request_hash    bytea       NULL CHECK (octet_length(request_hash) = 32),
    request_id      text        NULL,   -- X-Request-Id of the ingest call, logged by the worker
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- NULLs are distinct in a UNIQUE constraint: messages without a key are never deduplicated.
    CONSTRAINT messages_app_id_idempotency_key_key UNIQUE (app_id, idempotency_key),
    -- Target of the composite FK from deliveries; also serves "this app's messages, newest first".
    CONSTRAINT messages_app_id_id_key UNIQUE (app_id, id)
);

-- The queue (ADR 0002). One row per (message, subscribed endpoint).
CREATE TABLE deliveries (
    id              uuid        PRIMARY KEY DEFAULT uuidv7(),
    -- Denormalized from the message (ADR 0009): read APIs list "this app's deliveries" with one
    -- index, without joining messages. The composite FKs make a mismatch impossible.
    app_id          uuid        NOT NULL,
    message_id      uuid        NOT NULL,
    endpoint_id     uuid        NOT NULL,
    status          text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'in_flight', 'succeeded', 'dead')),
    -- Finished attempts (incremented when an attempt fails or succeeds). Reset to 0 by replay.
    attempt_count   int         NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    -- Fencing token (ADR 0009): +1 on every claim, never reset. Completion only applies if the
    -- token is still the one the worker got, so a worker whose lease expired can't overwrite
    -- the outcome of the worker that took over — even when both have the same WORKER_ID.
    claim_count     int         NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
    -- When the delivery is due next, in every claimable status (ADR 0009):
    --   pending   → when the (re)try may run;
    --   in_flight → when the lease expires (= locked_until), so a crashed worker's work comes back.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_by       text        NULL,   -- WORKER_ID holding the lease
    locked_until    timestamptz NULL,   -- lease expiry
    last_error      text        NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT deliveries_message_id_endpoint_id_key UNIQUE (message_id, endpoint_id),
    CONSTRAINT deliveries_message_fkey
        FOREIGN KEY (app_id, message_id) REFERENCES messages (app_id, id),
    CONSTRAINT deliveries_endpoint_fkey
        FOREIGN KEY (app_id, endpoint_id) REFERENCES endpoints (app_id, id),
    -- A delivery in flight always has an owner and a lease.
    CONSTRAINT deliveries_in_flight_has_lease
        CHECK (status <> 'in_flight' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL))
);

-- THE claim index (ADR 0009): only claimable rows are in it (partial), ordered by due time, so
-- "the oldest N due deliveries" is a short range scan however many succeeded/dead rows pile up.
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at)
    WHERE status IN ('pending', 'in_flight');
-- Read APIs: "this app's deliveries, newest first" and the endpoint filter / FK lookups.
CREATE INDEX deliveries_app_id_id_idx ON deliveries (app_id, id);
CREATE INDEX deliveries_endpoint_id_idx ON deliveries (endpoint_id);

-- One row per HTTP attempt, written by the worker — including attempts whose outcome was
-- discarded because the lease was lost (the request was still sent).
CREATE TABLE attempts (
    id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
    delivery_id           uuid        NOT NULL REFERENCES deliveries (id),
    -- attempt_count + 1 at claim time. Not unique: after a lost lease two workers can record
    -- the same number (at-least-once, ADR 0003).
    attempt_number        int         NOT NULL CHECK (attempt_number >= 1),
    worker_id             text        NOT NULL,
    started_at            timestamptz NOT NULL,
    duration_ms           int         NOT NULL CHECK (duration_ms >= 0),
    status_code           int         NULL,   -- NULL = no response (timeout, DNS, refused)
    error                 text        NULL,
    response_body_snippet text        NULL,   -- first 1 KiB, for debugging
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempts_delivery_id_id_idx ON attempts (delivery_id, id);

-- migrate:down
DROP TABLE attempts;
DROP TABLE deliveries;
DROP TABLE messages;
CREATE INDEX endpoints_app_id_id_idx ON endpoints (app_id, id);
ALTER TABLE endpoints DROP CONSTRAINT endpoints_app_id_id_key;
