import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
}

/**
 * Project cost attribution (#13): one tagged application inference profile (AIP) per
 * project × model. Calls made through an AIP are attributable with zero client effort —
 * the invocation log records the AIP ARN as `modelId`, and the `project` tag flows to
 * Cost Explorer / CUR once activated as a cost-allocation tag (manual Billing-console step).
 *
 * Opt-in enforcement (cfg.projects.enforcementPolicy): a managed policy that makes
 * project-tagged AIPs the ONLY invokable path (direct model ids are denied by omission —
 * the foundation-model grant applies only when the request arrives through an AIP), plus a
 * pilot test role for validating the deny/allow matrix. Attached to nothing else by default.
 */
export class ProjectsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg } = props;
    const seeds = cfg.projects?.seedProjects ?? [];

    for (const project of seeds) {
      for (const crisId of project.models ?? []) {
        // "us.anthropic.claude-sonnet-4-6" -> short suffix "sonnet-4-6" for readable names/ids.
        // Dated ids carry a ":<version>" suffix (e.g. haiku-4-5-20251001-v1:0) — sanitize for
        // the profile-name charset.
        const short = crisId.split('.').pop()!.replace(/^claude-/, '').replace(/[^A-Za-z0-9-]/g, '-');
        const cfnId = `Aip-${project.id}-${short}`.replace(/[^A-Za-z0-9-]/g, '');
        const profile = new bedrock.CfnApplicationInferenceProfile(this, cfnId, {
          inferenceProfileName: `tums-${cfg.env}-${project.id}-${short}`,
          // CFN restricts Description to ^([0-9a-zA-Z:.][ _-]?)+$ — plain words only.
          description: `Project ${project.id} cost attribution ${crisId}`,
          modelSource: {
            copyFrom: `arn:aws:bedrock:${cfg.region}:${cfg.account}:inference-profile/${crisId}`,
          },
          tags: [
            // Key is deliberately NOT 'project': the app-wide cdk.Tags aspect stamps
            // project=token-usage-monitoring on every resource (billing tag) and overrides a
            // same-key resource tag — observed live. 'tums-project' is the attribution key;
            // activate IT as the cost-allocation tag.
            { key: 'tums-project', value: project.id },
            ...(project.costCenter ? [{ key: 'cost_center', value: project.costCenter }] : []),
          ],
        });
        new cdk.CfnOutput(this, `AipArn-${project.id}-${short}`.replace(/[^A-Za-z0-9-]/g, ''), {
          value: profile.attrInferenceProfileArn,
          description: `AIP for ${project.id} / ${crisId} — use as ANTHROPIC_MODEL in .claude/settings.json`,
        });
      }
    }

    if (cfg.projects?.enforcementPolicy && seeds.length > 0) {
      const projectIds = seeds.map((p) => p.id);
      // The two-statement pattern (docs/research-project-cost-dora-attribution.md §2):
      // S1 — the caller may invoke only AIPs tagged with an allowed project.
      // S2 — the underlying foundation models are reachable ONLY through an AIP in this
      //      account (`bedrock:InferenceProfileArn` is absent on direct model-id calls, so
      //      they fail). CRIS routes across us-east-1/us-east-2/us-west-2 → all three legs.
      const policy = new iam.ManagedPolicy(this, 'ProjectOnlyPolicy', {
        managedPolicyName: `tums-${cfg.env}-bedrock-project-only`,
        description: 'Allows Bedrock invocation ONLY via project-tagged application inference profiles',
        statements: [
          new iam.PolicyStatement({
            sid: 'OnlyProjectTaggedProfiles',
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [`arn:aws:bedrock:${cfg.region}:${cfg.account}:application-inference-profile/*`],
            conditions: { StringEquals: { 'aws:ResourceTag/tums-project': projectIds } },
          }),
          new iam.PolicyStatement({
            sid: 'FoundationModelsOnlyViaProfiles',
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
              'arn:aws:bedrock:us-east-1::foundation-model/*',
              'arn:aws:bedrock:us-east-2::foundation-model/*',
              'arn:aws:bedrock:us-west-2::foundation-model/*',
            ],
            conditions: {
              ArnLike: {
                'bedrock:InferenceProfileArn':
                  `arn:aws:bedrock:${cfg.region}:${cfg.account}:application-inference-profile/*`,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: 'DiscoverProfiles',
            actions: ['bedrock:GetInferenceProfile', 'bedrock:ListInferenceProfiles'],
            resources: ['*'], // List does not support resource-level scoping
          }),
        ],
      });
      const pilotRole = new iam.Role(this, 'ProjectPilotRole', {
        roleName: `tums-${cfg.env}-project-pilot`,
        assumedBy: new iam.AccountPrincipal(cfg.account),
        description: 'Pilot role proving AIP-only enforcement: allow via profile, deny direct model ids',
      });
      pilotRole.addManagedPolicy(policy);
      new cdk.CfnOutput(this, 'PilotRoleArn', { value: pilotRole.roleArn });
      new cdk.CfnOutput(this, 'ProjectOnlyPolicyArn', { value: policy.managedPolicyArn });
    }
  }
}
