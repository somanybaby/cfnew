import RustWorker from './build/index.js';
import { withSubscriptions } from '../subscriptions/handler.mjs';

export default class extends RustWorker {
  fetch(request) {
    const core = { fetch: request => super.fetch(request) };
    return withSubscriptions(core).fetch(request, this.env, this.ctx);
  }
}
