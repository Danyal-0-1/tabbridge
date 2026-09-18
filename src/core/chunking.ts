import { TabBridgeError } from './errors.ts';

export const MAX_CHUNK_CHARACTERS = 7_000;

export function splitIntoChunks(value: string, maximum = MAX_CHUNK_CHARACTERS): string[] {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new TabBridgeError('VALIDATION_ERROR', 'Chunk size must be a positive integer.');
  }
  if (value.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maximum) {
    chunks.push(value.slice(offset, offset + maximum));
  }
  return chunks;
}

export function joinChunks(chunks: string[], expectedLength: number): string {
  if (chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new TabBridgeError('CORRUPT_DATA', 'A stored snapshot chunk is invalid.');
  }
  const combined = chunks.join('');
  if (combined.length !== expectedLength) {
    throw new TabBridgeError('CORRUPT_DATA', 'Stored snapshot chunks have an unexpected length.');
  }
  return combined;
}
