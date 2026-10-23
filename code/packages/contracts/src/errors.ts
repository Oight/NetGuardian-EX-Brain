import type { AppError, ErrorCode, Result } from './types.js';

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export function fail<T = never>(code: ErrorCode, message: string, retryable = false): Result<T> {
  return { ok: false, error: { code, message, retryable } };
}

/** Deliberately does not serialize the caught exception, SQL parameters or response body. */
export function internalError(code: ErrorCode = 'INTERNAL'): AppError {
  return { code, message: code === 'STORAGE_UNAVAILABLE' ? '本地存储操作失败' : '操作失败，请查看诊断身份', retryable: false };
}
