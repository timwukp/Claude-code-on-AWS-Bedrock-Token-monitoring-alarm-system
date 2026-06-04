import { APIGatewayProxyResult } from 'aws-lambda';

/** Standard JSON response helpers with permissive CORS (tighten origin in production). */
export const ok = (body: unknown): APIGatewayProxyResult => json(200, body);
export const badRequest = (message: string): APIGatewayProxyResult => json(400, { error: message });
export const notFound = (message = 'Not found'): APIGatewayProxyResult => json(404, { error: message });
export const serverError = (message = 'Internal error'): APIGatewayProxyResult => json(500, { error: message });

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*', // TODO: restrict to the CloudFront domain
    },
    body: JSON.stringify(body),
  };
}
