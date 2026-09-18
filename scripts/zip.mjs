import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit += 1) {
    result = (result & 1) === 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  }
  return result >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function filesUnder(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(directory, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported package entry: ${relative}`);
  }
  return files.sort(compareNames);
}

export async function deterministicZip(directory) {
  const names = await filesUnder(directory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of names) {
    if (name.startsWith('/') || name.includes('..') || name.includes('\\')) {
      throw new Error(`Unsafe ZIP entry: ${name}`);
    }
    const info = await stat(path.join(directory, name));
    if (!info.isFile()) throw new Error(`Not a regular file: ${name}`);
    const data = await readFile(path.join(directory, name));
    const encodedName = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, encodedName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encodedName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, encodedName);
    offset += local.length + encodedName.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
