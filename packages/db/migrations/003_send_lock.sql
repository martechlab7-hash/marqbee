-- Sends are claimed in Postgres with a short lease, so two concurrent deliveries
-- of the same job (possible with HTTP queues like QStash) can never both send.
ALTER TABLE messages ADD COLUMN locked_until timestamptz;
