import { AppError } from './errors';
import type { ConnectionConfig } from './ports';

export const DEFAULT_API_URL = 'https://api.green-api.com';

const greenApiHostPattern = /^(?:\d+\.)?api\.green-api\.com$/;
const instanceIdPattern = /^\d{1,20}$/;
const apiTokenPattern = /^[a-zA-Z0-9_-]+$/;

function validateApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError('configuration', 'Укажите адрес API из личного кабинета GREEN-API.');
  }

  const isGreenApiHost = url.protocol === 'https:' && greenApiHostPattern.test(url.hostname);
  const hasExtraParts =
    url.pathname !== '/' ||
    Boolean(url.port || url.username || url.password || url.search || url.hash);

  if (!isGreenApiHost || hasExtraParts) {
    throw new AppError(
      'configuration',
      'Нужен HTTPS-адрес API GREEN-API без пути и дополнительных параметров.',
    );
  }

  return url.origin;
}

export function validateConfig(input: ConnectionConfig): ConnectionConfig {
  const apiUrl = validateApiOrigin(input.apiUrl);
  const idInstance = input.idInstance.trim();
  const apiTokenInstance = input.apiTokenInstance.trim();

  if (!instanceIdPattern.test(idInstance)) {
    throw new AppError('configuration', 'ID инстанса должен содержать только цифры.');
  }

  if (!apiTokenPattern.test(apiTokenInstance)) {
    throw new AppError(
      'configuration',
      'Проверьте токен: скопируйте его целиком из личного кабинета.',
    );
  }

  return { apiUrl, idInstance, apiTokenInstance };
}
