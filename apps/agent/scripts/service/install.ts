import { installService } from '../../src/service/install.ts';

const args = new Set(Bun.argv.slice(2));
await installService({
  printOnly: args.has('--print'),
  noStart: args.has('--no-start'),
});
