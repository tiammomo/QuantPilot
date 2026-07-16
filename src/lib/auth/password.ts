import { hash, verify } from '@node-rs/argon2';

import {
  getDevelopmentAdminDefaults,
  getProjectAuthConfig,
  type AuthEnvironment,
} from '@/lib/config/auth';

export function validateAuthPassword(password: string): string | null {
  const { minLength, maxLength } = getProjectAuthConfig().password;
  const length = Array.from(password).length;
  if (length < minLength) return `密码至少需要 ${minLength} 个字符。`;
  if (length > maxLength) return `密码不能超过 ${maxLength} 个字符。`;
  return null;
}

export async function hashAuthPassword(
  password: string,
  bootstrapOptions?: {
    allowDevelopmentDefault: true;
    environment?: AuthEnvironment;
  },
): Promise<string> {
  const error = validateAuthPassword(password);
  if (error) {
    const defaults = bootstrapOptions?.allowDevelopmentDefault
      ? getDevelopmentAdminDefaults(
          getProjectAuthConfig(bootstrapOptions.environment),
          bootstrapOptions.environment,
        )
      : null;
    if (!defaults || password !== defaults.password) throw new Error(error);
  }
  const options = getProjectAuthConfig().password.argon2id;
  return hash(password, {
    algorithm: 2, // @node-rs/argon2 Algorithm.Argon2id; numeric form supports isolatedModules.
    memoryCost: options.memoryCostKiB,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
    outputLen: options.outputLength,
  });
}

export async function verifyAuthPassword(hashValue: string, password: string): Promise<boolean> {
  if (!hashValue || !password) return false;
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}
