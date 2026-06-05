import { APIGatewayProxyResult } from 'aws-lambda';

/** Standard JSON response helpers with permissive CORS (tighten origin in production). */
export const ok = (body: unknown): APIGatewayProxyResult => json(200, body);
export const badRequest = (message: string): APIGatewayProxyResult => json(400, { error: message });
export const notFound = (message = 'Not found'): APIGatewayProxyResult => json(404, { error: message });
export const serverError = (message = 'Internal error'): APIGatewayProxyResult => json(500, { error: message });

// Origin for Access-Control-Allow-Origin. Set ALLOWED_ORIGIN to your dashboard origin in
// production; defaults to "*" for demo. Must match the API Gateway preflight configuration.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
  };
}
