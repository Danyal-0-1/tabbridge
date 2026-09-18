export interface UrlDecision {
  allowed: boolean;
  normalized?: string;
  reason?: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function assessUrl(value: unknown): UrlDecision {
  if (typeof value !== 'string' || value.length === 0) {
    return { allowed: false, reason: 'The tab has no restorable URL.' };
  }
  if (value.length > 16_384) {
    return { allowed: false, reason: 'The URL exceeds the safety limit.' };
  }

  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return {
        allowed: false,
        reason: `The ${parsed.protocol || 'unknown'} scheme is not allowed.`,
      };
    }
    return { allowed: true, normalized: parsed.href };
  } catch {
    return { allowed: false, reason: 'The URL is malformed.' };
  }
}

export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}
