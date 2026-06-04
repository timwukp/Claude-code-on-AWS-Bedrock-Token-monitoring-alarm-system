import * as path from 'path';

/** Absolute path to the backend package (sibling of infra). NodejsFunction needs projectRoot
 * + depsLockFilePath pointed here because handlers live outside the CDK app directory. */
export const BACKEND_ROOT = path.join(__dirname, '..', '..', '..', 'backend');
export const BACKEND_LOCK = path.join(BACKEND_ROOT, 'package-lock.json');
export const lambdaEntry = (...segments: string[]) => path.join(BACKEND_ROOT, 'lambdas', ...segments);
