import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ANOMALIES_TABLE!;

/**
 * GET /v1/anomalies — the anomaly/alert feed for the tenant. Items are mirrored into DynamoDB
 * from the SNS alert topic (Cost Anomaly Detection + custom signals) so the dashboard reads
 * are fast and don't depend on Cost Explorer API latency.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#ANOMALY` },
        ScanIndexForward: false, // newest first
        Limit: 100,
      }),
    );
    return ok({ tenantId, anomalies: res.Items ?? [] });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};
