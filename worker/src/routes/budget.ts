/**
 * Free-tier budget indicator (`GET /api/budget`, SoW §1.1 + Dashboard screen).
 * Returns today's Workers/D1/Queues usage vs limits and whether the governor has degraded.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getBudget } from '../lib/budget';

export const budgetRouter = new Hono<AppEnv>();

budgetRouter.get('/', async (c) => {
  return c.json(await getBudget(c.env));
});
