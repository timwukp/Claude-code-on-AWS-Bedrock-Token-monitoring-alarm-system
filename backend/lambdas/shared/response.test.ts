describe('response CORS origin', () => {
  const load = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./response');
  };

  afterEach(() => { delete process.env.ALLOWED_ORIGIN; });

  it('defaults Access-Control-Allow-Origin to "*" when ALLOWED_ORIGIN is unset', () => {
    delete process.env.ALLOWED_ORIGIN;
    const { ok } = load();
    expect(ok({}).headers['access-control-allow-origin']).toBe('*');
  });

  it('echoes the configured origin in production', () => {
    process.env.ALLOWED_ORIGIN = 'https://dash.example.com';
    const { ok } = load();
    expect(ok({}).headers['access-control-allow-origin']).toBe('https://dash.example.com');
  });

  it('sets the right status codes for the helpers', () => {
    const { ok, badRequest, notFound, serverError } = load();
    expect(ok({}).statusCode).toBe(200);
    expect(badRequest('x').statusCode).toBe(400);
    expect(notFound().statusCode).toBe(404);
    expect(serverError().statusCode).toBe(500);
  });
});
