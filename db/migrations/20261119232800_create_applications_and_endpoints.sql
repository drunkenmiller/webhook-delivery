-- migrate:up

-- Producers ("customers") of the service. Each one authenticates with an API key
-- `whd_<prefix>_<secret>`: only the public prefix (for lookup/display) and the SHA-256 of the
-- whole key are stored, so a database leak does not reveal usable keys (ADR 0007).
CREATE TABLE applications (
    id             uuid        PRIMARY KEY DEFAULT uuidv7(),
    name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    api_key_prefix text        NOT NULL UNIQUE,
    api_key_hash   bytea       NOT NULL CHECK (octet_length(api_key_hash) = 32),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Customer URLs that receive webhooks. `secret` is kept in plaintext because the worker needs
-- it to sign every request (ADR 0007). Endpoints are never deleted, only deactivated, so the
-- delivery history that references them stays intact.
CREATE TABLE endpoints (
    id          uuid        PRIMARY KEY DEFAULT uuidv7(),
    app_id      uuid        NOT NULL REFERENCES applications (id),
    url         text        NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
    secret      text        NOT NULL CHECK (secret LIKE 'whsec\_%'),
    event_types text[]      NOT NULL DEFAULT '{}',   -- empty = subscribed to every event type
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()   -- set by the API on every UPDATE
);

-- Serves "this application's endpoints, newest first" (cursor pagination on the uuidv7 id)
-- and the FK lookups by app_id (PostgreSQL does not index foreign keys automatically).
CREATE INDEX endpoints_app_id_id_idx ON endpoints (app_id, id);

-- migrate:down
DROP TABLE endpoints;
DROP TABLE applications;
