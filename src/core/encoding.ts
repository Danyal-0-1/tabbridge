import { TabBridgeError } from './errors.ts';

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let index = 0; index < bytes.length; index += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + blockSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TabBridgeError('CORRUPT_DATA', 'Encrypted data contains invalid base64.');
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    throw new TabBridgeError('CORRUPT_DATA', 'Encrypted data contains invalid base64.', {
      cause: error,
    });
  }
}

export function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw new TabBridgeError('CORRUPT_DATA', 'Decrypted data is not valid UTF-8.', {
      cause: error,
    });
  }
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
