export type ErrorCode =
  | 'LOCKED'
  | 'NOT_CONFIGURED'
  | 'WRONG_PASSPHRASE'
  | 'CORRUPT_DATA'
  | 'INVALID_IMPORT'
  | 'UNSUPPORTED_VERSION'
  | 'QUOTA_FULL'
  | 'SYNC_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_URL'
  | 'VALIDATION_ERROR'
  | 'CANCELLED'
  | 'BROWSER_ERROR';

export class TabBridgeError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TabBridgeError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'An unknown error occurred.';
}

export function publicError(error: unknown): {
  code: ErrorCode | 'GENERAL_ERROR';
  message: string;
} {
  if (error instanceof TabBridgeError) return { code: error.code, message: error.message };
  return { code: 'GENERAL_ERROR', message: errorMessage(error) };
}
