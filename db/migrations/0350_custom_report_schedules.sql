-- 0350 · Custom reports scheduled
-- A scheduled export may send one of the shop's custom reports in place of its orders (ANL-06):
-- the report run over the day, week or month that just ended, as a workbook, to the member of
-- staff who scheduled it. Deleting the report deletes its schedules. See ADR-818 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.export_schedules
  ADD COLUMN report_id uuid,
  ADD CONSTRAINT export_schedules_report_fkey FOREIGN KEY (shop_id, report_id)
    REFERENCES orders.custom_reports (shop_id, id) ON DELETE CASCADE,
  -- A report goes as a workbook, filtered by nothing but its period.
  ADD CONSTRAINT export_schedules_report_check
    CHECK (report_id IS NULL OR (format = 'xlsx' AND query = ''));
