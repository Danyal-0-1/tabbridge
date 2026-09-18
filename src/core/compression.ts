import { TabBridgeError } from './errors.ts';
import { asArrayBuffer } from './encoding.ts';
import { LIMITS } from './schema.ts';

async function transform(
  input: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maximumOutputBytes: number,
): Promise<Uint8Array> {
  const transformed = new Blob([asArrayBuffer(input)]).stream().pipeThrough(stream);
  const reader = transformed.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumOutputBytes) {
      await reader.cancel();
      throw new TabBridgeError('CORRUPT_DATA', 'Decompressed data exceeds the safety limit.');
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function compress(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new TabBridgeError(
      'BROWSER_ERROR',
      'This browser does not provide secure local compression.',
    );
  }
  return transform(input, new CompressionStream('gzip'), LIMITS.importBytes);
}

export async function decompress(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new TabBridgeError(
      'BROWSER_ERROR',
      'This browser does not provide secure local decompression.',
    );
  }
  try {
    return await transform(input, new DecompressionStream('gzip'), LIMITS.decompressedBytes);
  } catch (error) {
    throw new TabBridgeError('CORRUPT_DATA', 'The encrypted payload could not be decompressed.', {
      cause: error,
    });
  }
}
