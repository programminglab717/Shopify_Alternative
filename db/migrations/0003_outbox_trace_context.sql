-- 0003 · Trace context on outbox events
-- The W3C traceparent of the request that recorded an event, so the worker that handles the event
-- joins the same trace: API request → database → outbox → queue → worker.
ALTER TABLE platform.outbox_events ADD COLUMN trace_context text;
