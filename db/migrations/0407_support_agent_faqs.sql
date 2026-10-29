-- 0407 · The AI's answers from the shop's FAQs
-- A shop writes its answers to the questions its customers ask most, and the AI answering its
-- customers (MSG-07) answers from them as it does from its policies. See ADR-911 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE messaging.support_agent_settings
  ADD COLUMN faqs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(faqs) = 'array');
