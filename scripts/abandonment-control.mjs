// Test-only preload for the production abandonment check: the unexpected-error
// control. A request marked with the header below, once its caller has left,
// reports a failure that is not a departure on that request, so the check can
// see that an expected departure does not hide an unrelated error. It holds
// no work and adds no endpoint; nothing else is changed.
import { Server } from 'node:http';

const MARK = 'x-dezfil-test-unrelated-failure';
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  const [request] = args;
  if (event === 'request' && request.headers[MARK]) {
    request.socket?.once('close', () => setImmediate(() => request.emit('error', new Error('Unrelated failure after the caller left.'))));
  }
  return emit.call(this, event, ...args);
};
