/** Events the logistics module publishes. Payloads are thin: fetch current state through the API. */
export const LogisticsEvents = {
  /** A courier's remittance statement was imported, and its cash received on orders. */
  CodRemittanceImported: 'cod_remittance.imported',
} as const;

export interface CodRemittanceImportedPayload {
  courier: string;
  reference: string | null;
  lineCount: number;
  /** Minor units, as strings: the cash the courier collected, and what was received on orders. */
  collected: string;
  received: string;
}
