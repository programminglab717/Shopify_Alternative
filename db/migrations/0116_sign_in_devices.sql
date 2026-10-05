-- Sign-in alerts (ADM-02, ADR-179): a session keeps the device it signed in from, as its client
-- names it: a digest of the account's ID with the random ID the client keeps for the device it
-- runs on, sent with each sign-in (X-Hatti-Device). A sign-in from a device none of the account's
-- sessions was used from lately tells the account's owner. A session whose client keeps no ID has
-- none, and its device is its user agent alone.

ALTER TABLE identity.sessions ADD COLUMN device_hash bytea;
