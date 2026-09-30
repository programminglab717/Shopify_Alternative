import { Resolver } from 'node:dns/promises';

/**
 * What DNS says of a host, for checking that a shop's own domain points at the platform
 * (ADR-048). Provided by the host application; tests give one of their own.
 */
export abstract class DnsLookup {
  /** The hosts the host's CNAME records name; none when it has none, or does not exist. */
  abstract cnames(host: string): Promise<string[]>;
  /** The host's IPv4 and IPv6 addresses; none when it has none, or does not exist. */
  abstract addresses(host: string): Promise<string[]>;
}

/** Answers that mean there is nothing of the kind asked for, rather than that DNS failed. */
const NOTHING = new Set(['ENODATA', 'ENOTFOUND']);

/** The system's resolvers, each question asked twice at most, for five seconds each time. */
export class SystemDnsLookup extends DnsLookup {
  readonly #resolver = new Resolver({ timeout: 5_000, tries: 2 });

  cnames(host: string): Promise<string[]> {
    return this.#resolver.resolveCname(host).catch(nothingOr);
  }

  async addresses(host: string): Promise<string[]> {
    const [v4, v6] = await Promise.all([
      this.#resolver.resolve4(host).catch(nothingOr),
      this.#resolver.resolve6(host).catch(nothingOr),
    ]);
    return [...v4, ...v6];
  }
}

function nothingOr(error: NodeJS.ErrnoException): string[] {
  if (error.code && NOTHING.has(error.code)) return [];
  throw error;
}
