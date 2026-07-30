import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';

/**
 * CDK Aspect: stamps a Permission Boundary onto every IAM Role synthesised in this app.
 *
 * Security pillar (SEC05 — reduce blast radius): the boundary acts as a hard ceiling so that
 * even a misconfigured or over-permissive identity policy cannot cross into sibling systems
 * (e.g. token-monitor roles cannot modify llmops Lambdas, and vice-versa).
 *
 * Why an Aspect instead of editing each stack:
 *   - Roles are also auto-created by NodejsFunction, Fargate, Budget Actions, etc.
 *     An Aspect runs at synthesis time against every iam.Role in the construct tree,
 *     so future additions are covered automatically with no per-stack changes.
 *
 * Usage:
 *   cdk.Aspects.of(app).add(new PermissionBoundaryAspect(
 *     `arn:aws:iam::${cfg.account}:policy/TokenMonitorPermissionBoundary`
 *   ));
 */
export class PermissionBoundaryAspect implements cdk.IAspect {
  constructor(private readonly boundaryArn: string) {}

  visit(node: IConstruct): void {
    if (!(node instanceof iam.Role)) return;
    iam.PermissionsBoundary.of(node).apply(
      iam.ManagedPolicy.fromManagedPolicyArn(node, 'PermBoundaryRef', this.boundaryArn),
    );
  }
}
