/**
 * Entry point for `acabox-share-api`. Routing (contract C4) lives in
 * `routes.ts`; this file is just the Workers `fetch` handler shape.
 */

import type { ApiEnv } from '../../shared/bucket';
import { handleApiRequest } from './routes';

export default {
  fetch: (request: Request, env: ApiEnv): Promise<Response> => handleApiRequest(request, env),
};
