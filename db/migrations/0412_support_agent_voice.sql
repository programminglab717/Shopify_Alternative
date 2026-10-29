-- 0412 · The AI support agent's name and tone, as the shop sets them (MSG-07)
-- A shop names the assistant that answers its customers, "Sana from Zari", and says whether it
-- writes warmly, as a shopkeeper would, or formally. The name is given the model as the shop's
-- words; the tone picks one of Hatti's own instructions. See ADR-923 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE messaging.support_agent_settings
  ADD COLUMN agent_name text CHECK (char_length(agent_name) BETWEEN 1 AND 40),
  ADD COLUMN tone text NOT NULL DEFAULT 'warm' CHECK (tone IN ('warm', 'formal'));
