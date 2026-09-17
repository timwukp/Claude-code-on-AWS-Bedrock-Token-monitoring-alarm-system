import { isAdmin, parseGroupsClaim } from './admin';

const withGroups = (groups: unknown) =>
  ({ requestContext: { authorizer: { claims: { 'cognito:groups': groups } } } }) as any;

describe('parseGroupsClaim', () => {
  it('handles every shape the Cognito authorizer produces', () => {
    expect(parseGroupsClaim(undefined)).toEqual([]);
    expect(parseGroupsClaim(null)).toEqual([]);
    expect(parseGroupsClaim('admin')).toEqual(['admin']);
    expect(parseGroupsClaim('admin,viewer')).toEqual(['admin', 'viewer']);
    expect(parseGroupsClaim('[admin, viewer]')).toEqual(['admin', 'viewer']);
    expect(parseGroupsClaim('[admin viewer]')).toEqual(['admin', 'viewer']);
    expect(parseGroupsClaim(['admin'])).toEqual(['admin']);
    expect(parseGroupsClaim(42)).toEqual([]);
  });
});

describe('isAdmin', () => {
  it('is true only for members of the admin group', () => {
    expect(isAdmin(withGroups('admin'))).toBe(true);
    expect(isAdmin(withGroups('[viewer, admin]'))).toBe(true);
    expect(isAdmin(withGroups('viewer'))).toBe(false);
    expect(isAdmin(withGroups('administrators'))).toBe(false);
    expect(isAdmin({ requestContext: { authorizer: { claims: {} } } } as any)).toBe(false);
    expect(isAdmin({ requestContext: {} } as any)).toBe(false);
  });
});
