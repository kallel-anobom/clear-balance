export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m = 'Registro não encontrado.') => new HttpError(404, m);
