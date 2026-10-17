-- Trax's statuses, as its tracking says them (SHP-01, ADR-510). A status no row names, and that
-- is not written as Hatti names its own, is asked about again as one on its way: a status Trax
-- adds waits for its row.
INSERT INTO logistics.courier_statuses (courier, raw, status) VALUES
  ('trax', 'shipment - booked', 'booked'),
  ('trax', 'shipment booked', 'booked'),
  ('trax', 'pickup request sent', 'booked'),
  ('trax', 'shipment - picked up', 'in_transit'),
  ('trax', 'shipment picked up', 'in_transit'),
  ('trax', 'shipment - arrived at origin', 'in_transit'),
  ('trax', 'shipment - in transit', 'in_transit'),
  ('trax', 'shipment - arrived at destination', 'in_transit'),
  ('trax', 'shipment - out for delivery', 'out_for_delivery'),
  ('trax', 'out for delivery', 'out_for_delivery'),
  ('trax', 'shipment - delivery attempted', 'attempted'),
  ('trax', 'shipment - not delivered', 'attempted'),
  ('trax', 'shipment - on hold', 'attempted'),
  ('trax', 'shipment - refused by consignee', 'attempted'),
  ('trax', 'shipment - delivered', 'delivered'),
  ('trax', 'shipment - return in process', 'returning'),
  ('trax', 'return - in transit', 'returning'),
  ('trax', 'shipment - returned to shipper', 'returned'),
  ('trax', 'return - delivered to shipper', 'returned'),
  ('trax', 'shipment - lost', 'lost'),
  ('trax', 'shipment - cancelled', 'cancelled');
