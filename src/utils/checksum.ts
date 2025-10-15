import crypto from 'crypto';
import fs from 'fs';

/**
 * Calculate SHA256 checksum for a file
 * @param filePath - Absolute path to the file
 * @returns Promise<string> - Checksum in format "sha256:hex"
 */
export async function calculateChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
    stream.on('error', reject);
  });
}
