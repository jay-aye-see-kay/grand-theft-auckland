// The core actions again in the test town (?map=test).
import { coreActions } from './core.mjs';

export default {
  name: 'test-town',
  core: false,
  page: 'test',
  run: (t) => coreActions(t, ' [test town]'),
};
