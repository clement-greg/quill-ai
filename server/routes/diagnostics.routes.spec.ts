/**
 * The diagnostics endpoint exists to make a model misconfiguration visible, so
 * the tests that matter are: it reports the resolved tiers, and it never leaks
 * the API key.
 */
const createMock = jest.fn();

jest.mock('openai', () => ({
  AzureOpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

import express from 'express';
import request from 'supertest';
import config from '../config';
import diagnosticsRoutes from './diagnostics.routes';

const app = express();
app.use(express.json());
app.use('/api/diagnostics', diagnosticsRoutes);

const SECRET_KEY = 'super-secret-foundry-key';

beforeEach(() => {
  createMock.mockReset();
  Object.assign(config.foundry, {
    endpoint: 'https://cogent-ai-2.openai.azure.com/',
    key: SECRET_KEY,
    apiVersion: '2025-04-01-preview',
    embeddingModel: 'text-embedding-3-small',
    lowModel: 'gpt-5.6-luna',
    midModel: 'gpt-5.6-terra',
    highModel: 'gpt-5.6-sol',
  });
});

describe('GET /api/diagnostics/config', () => {
  it('reports the resolved tiers and endpoint host', async () => {
    const res = await request(app).get('/api/diagnostics/config');

    expect(res.status).toBe(200);
    expect(res.body.foundry.endpointHost).toBe('cogent-ai-2.openai.azure.com');
    expect(res.body.foundry.tiers).toEqual({
      low: 'gpt-5.6-luna',
      mid: 'gpt-5.6-terra',
      high: 'gpt-5.6-sol',
    });
    expect(res.body.foundry.keyConfigured).toBe(true);
  });

  it('never includes the API key or its length', async () => {
    const res = await request(app).get('/api/diagnostics/config');
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(SECRET_KEY);
    expect(body).not.toContain(String(SECRET_KEY.length));
  });

  it('marks an unset tier rather than reporting an empty name', async () => {
    config.foundry.midModel = '';
    const res = await request(app).get('/api/diagnostics/config');

    expect(res.body.foundry.tiers.mid).toBe('(unset)');
  });
});

describe('POST /api/diagnostics/chat-tiers', () => {
  it('reports which deployment served each tier when all succeed', async () => {
    createMock.mockImplementation(async ({ model }: { model: string }) => ({
      model: `${model}-2026-07-09`,
    }));

    const res = await request(app).post('/api/diagnostics/chat-tiers');

    expect(res.status).toBe(200);
    expect(res.body.tiers.low).toEqual({
      deployment: 'gpt-5.6-luna',
      ok: true,
      servedBy: 'gpt-5.6-luna-2026-07-09',
    });
    expect(res.body.tiers.high.ok).toBe(true);
  });

  it('surfaces the real status and message for a failing tier', async () => {
    createMock.mockImplementation(async ({ model }: { model: string }) => {
      if (model === 'gpt-5.6-terra') {
        throw Object.assign(new Error('404 Resource not found'), { status: 404, code: '404' });
      }
      return { model };
    });

    const res = await request(app).post('/api/diagnostics/chat-tiers');

    expect(res.body.tiers.mid).toMatchObject({
      deployment: 'gpt-5.6-terra',
      ok: false,
      status: 404,
      message: '404 Resource not found',
    });
    expect(res.body.tiers.low.ok).toBe(true);
  });

  it('probes every tier even when one throws', async () => {
    createMock.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/diagnostics/chat-tiers');

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(Object.keys(res.body.tiers)).toEqual(['low', 'mid', 'high']);
  });
});
