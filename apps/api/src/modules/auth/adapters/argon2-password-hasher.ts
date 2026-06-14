import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { argon2id, argon2Verify } from 'hash-wasm';
import { needsRehash as needsRehashPure } from '@b2b/domain';
import { AppConfigService } from '../../../common/config/app-config.service';
import type { PasswordHasher } from '../ports/password-hasher.port';

const SALT_BYTES = 16;
const HASH_BYTES = 32;

/**
 * argon2id password hasher (hash-wasm — pure WASM, no native build).
 *
 * - Salt is generated here from a CSPRNG (16 bytes) per hash.
 * - Parameters come from central config (memory/iterations/parallelism) so they
 *   are tuned in one validated place (TASK-009 §4).
 * - Verification uses the library's constant-time `argon2Verify`; a malformed or
 *   non-argon2 stored hash yields `false` rather than throwing.
 * - The encoded PHC string embeds the parameters, enabling transparent rehash
 *   on login when the policy is strengthened.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly config: AppConfigService) {}

  async hash(password: string): Promise<string> {
    const { memoryKiB, iterations, parallelism } = this.config.argon2;
    return argon2id({
      password,
      salt: randomBytes(SALT_BYTES),
      memorySize: memoryKiB,
      iterations,
      parallelism,
      hashLength: HASH_BYTES,
      outputType: 'encoded',
    });
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await argon2Verify({ password, hash });
    } catch {
      // Unsupported/garbled hash → not a match (never leak the parse error).
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return needsRehashPure(hash, this.config.argon2);
  }
}
