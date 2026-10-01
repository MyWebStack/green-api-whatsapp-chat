export type ErrorKind =
  | 'auth'
  | 'configuration'
  | 'temporary'
  | 'rate'
  | 'recipient'
  | 'protocol'
  | 'internal'
  | 'cancelled';

export class AppError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AppError('cancelled', 'Операция отменена.');
  }

  return new AppError(
    'internal',
    'Неожиданная ошибка приложения. Обновите страницу и повторите действие.',
  );
}

export const canRetry = (error: AppError) => error.kind === 'temporary' || error.kind === 'rate';
