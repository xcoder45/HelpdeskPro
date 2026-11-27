import request from 'supertest';

export async function createClient(app) {
  const agent = request.agent(app);
  const response = await agent.get('/api/auth/csrf');
  if (response.status !== 200 || !response.body?.data?.csrfToken) {
    throw new Error('Could not obtain a CSRF token');
  }
  return { agent, csrfToken: response.body.data.csrfToken };
}

export async function loginClient(app, email, password) {
  const client = await createClient(app);
  const response = await client.agent
    .post('/api/auth/login')
    .set('x-csrf-token', client.csrfToken)
    .send({ email, password });

  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }

  // Login rotates the CSRF token; subsequent state-changing requests must use the new one.
  return {
    ...client,
    csrfToken: response.body.data.csrfToken,
    response,
    user: response.body.data.user
  };
}

export function csrfHeader(client) {
  return { 'x-csrf-token': client.csrfToken };
}
