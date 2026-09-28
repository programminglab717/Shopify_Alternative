-- 0009 · Orders' customers
-- Every order belongs to the customer with its mobile number. Orders placed before customers
-- existed get theirs here. See ADR-023 in docs/architecture/13-decision-log.md.

-- No foreign key: the customer belongs to the customers module.
ALTER TABLE orders.orders ADD COLUMN customer_id uuid;

-- A customer for every number that has ordered: named as on its latest order, with the latest
-- email it gave, a customer since its first order. Its search text is its latest order's, which
-- holds the city as well as the name and email until the customer next changes.
INSERT INTO customers.customers (shop_id, id, phone, name, email, search_text, created_at)
SELECT DISTINCT ON (shop_id, phone)
       shop_id,
       platform.uuidv7(),
       phone,
       shipping_address ->> 'name',
       first_value(email) OVER (PARTITION BY shop_id, phone ORDER BY email IS NULL, id DESC),
       search_text,
       min(created_at) OVER (PARTITION BY shop_id, phone)
  FROM orders.orders
 ORDER BY shop_id, phone, id DESC;

UPDATE orders.orders o
   SET customer_id = c.id
  FROM customers.customers c
 WHERE c.shop_id = o.shop_id AND c.phone = o.phone;

ALTER TABLE orders.orders ALTER COLUMN customer_id SET NOT NULL;

-- A customer's orders, newest first, and what they add up to.
CREATE INDEX orders_customer_idx ON orders.orders (shop_id, customer_id, id DESC);
