import { runInteractiveAuth } from '../gmail.js';

runInteractiveAuth().catch((e) => {
  console.error('OAuth dance failed:', e);
  process.exit(1);
});
