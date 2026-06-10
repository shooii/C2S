export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function assertFound<T>(value: T | undefined | null, message = "资源不存在"): T {
  if (value === undefined || value === null) {
    throw new HttpError(404, message);
  }
  return value;
}

