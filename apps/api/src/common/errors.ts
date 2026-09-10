import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorBody } from './http-error.filter';

/** Erro de aplicação já no formato da resposta. */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    const body: ErrorBody = { error: details === undefined ? { code, message } : { code, message, details } };
    super(body, status);
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, code, message, details);
}

export function unauthorized(code: string, message: string): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, code, message);
}

export function forbidden(code: string, message: string): AppError {
  return new AppError(HttpStatus.FORBIDDEN, code, message);
}

export function notFound(code: string, message: string): AppError {
  return new AppError(HttpStatus.NOT_FOUND, code, message);
}

/** Recurso já existe, ou já pertence a outra pessoa. */
export function conflict(code: string, message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, code, message);
}

export function payloadTooLarge(code: string, message: string): AppError {
  return new AppError(HttpStatus.PAYLOAD_TOO_LARGE, code, message);
}

export function unsupportedMedia(code: string, message: string): AppError {
  return new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, code, message);
}

export function serviceUnavailable(code: string, message: string): AppError {
  return new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message);
}
