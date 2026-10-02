-- Leopards' statuses, as its tracking says them (SHP-01, ADR-162). A status no row names, and that
-- is not written as Hatti names its own, is asked about again as one on its way: a status Leopards
-- adds waits for its row.
INSERT INTO logistics.courier_statuses (courier, raw, status) VALUES
  ('leopards', 'pickup request not send', 'booked'),
  ('leopards', 'pickup request sent', 'booked'),
  ('leopards', 'consignment booked', 'booked'),
  ('leopards', 'shipment picked', 'in_transit'),
  ('leopards', 'drop off at express center', 'in_transit'),
  ('leopards', 'arrived at station', 'in_transit'),
  ('leopards', 'dispatched', 'in_transit'),
  ('leopards', 'missroute', 'in_transit'),
  ('leopards', 'assign to courier', 'out_for_delivery'),
  ('leopards', 'pending', 'attempted'),
  ('leopards', 'undelivered', 'attempted'),
  ('leopards', 'ready for return', 'returning'),
  ('leopards', 'being return', 'returning'),
  ('leopards', 'being returned', 'returning'),
  ('leopards', 'return to origin', 'returning'),
  ('leopards', 'returned to shipper', 'returned'),
  ('leopards', 'return to shipper', 'returned');
