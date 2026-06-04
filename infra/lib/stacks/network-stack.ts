import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
}

/**
 * Minimal VPC for the Fargate ETL workload only. The API and event paths are serverless and
 * stay outside the VPC where possible (Performance/Cost pillars). Gateway endpoints for S3 and
 * DynamoDB keep ETL traffic off the public internet (Security pillar).
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  private readonly cfgRegion: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    this.cfgRegion = props.cfg.region;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // TODO: 0 with VPC endpoints only if the ETL task needs no public egress
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addGatewayEndpoint('DynamoEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
  }

  /**
   * Return deterministic AZs instead of doing an account context lookup. This keeps `cdk synth`
   * environment-independent (works in CI with a placeholder account, no AWS calls) and makes
   * deploys reproducible. Uses the first two AZs of the configured region.
   */
  get availabilityZones(): string[] {
    return [`${this.cfgRegion}a`, `${this.cfgRegion}b`];
  }
}
