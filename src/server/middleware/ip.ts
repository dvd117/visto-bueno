import { isIP } from 'node:net';

export interface ClientIpInput {
  forwardedFor?: string | null;
  remoteAddress?: string | null;
}

export interface ClientIpOptions {
  trustProxy?: string | boolean;
}

/** Uses only the rightmost forwarded address when exactly one proxy hop is trusted. */
export function getClientIp(input: ClientIpInput, options: ClientIpOptions = {}): string | null {
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY;

  if (trustProxy === true || trustProxy === '1') {
    const forwardedIp = input.forwardedFor?.split(',').at(-1)?.trim();
    if (forwardedIp && isIP(forwardedIp) !== 0) return forwardedIp;
  }

  const remoteIp = input.remoteAddress?.trim();
  return remoteIp && isIP(remoteIp) !== 0 ? remoteIp : null;
}
