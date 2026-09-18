import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { ANOMALY_SK_PREFIX, anomalyPk } from '../shared/anomaly-key';

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
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        // Built from shared/anomaly-key, the same module every writer uses — a literal here is how
        // the anomaly-response writer's keys came to be unreadable by this query.
        ExpressionAttributeValues: { ':pk': anomalyPk(tenantId), ':skPrefix': ANOMALY_SK_PREFIX },
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
