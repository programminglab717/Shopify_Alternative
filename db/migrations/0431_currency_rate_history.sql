-- 0431 · Each day's currency rates, kept
-- The currency feed's rates (ADR-865) are kept by the day they were given as well as the latest,
-- so that an expansion store's sales of a day are put in this shop's currency at that day's rate
-- (CH-11). A day the feed gave no new rate takes the last before it. See ADR-974 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE platform.currency_rate_history (
  currency  text           NOT NULL
                           CHECK (currency IN ('AED', 'SAR', 'GBP', 'USD', 'CAD', 'EUR')),
  rate_date date           NOT NULL,
  -- Rupees for one unit, on that day.
  rate      numeric(10, 4) NOT NULL CHECK (rate > 0),
  PRIMARY KEY (currency, rate_date)
);

-- The rates already given, as of their day.
INSERT INTO platform.currency_rate_history (currency, rate_date, rate)
SELECT currency, rate_date, rate FROM platform.currency_rates;

GRANT SELECT, INSERT, UPDATE ON platform.currency_rate_history TO hatti_system_role;
GRANT SELECT ON platform.currency_rate_history TO hatti_app_role;
