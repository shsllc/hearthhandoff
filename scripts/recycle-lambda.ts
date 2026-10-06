// After editing the hearthhandoff/runtime secret, start fresh Lambda environments so they re-read it.
// Changing only the function description does this without touching environment variables.
//   AWS_PROFILE=... npm run aws:recycle
import { execFileSync } from 'node:child_process';

const region = process.env.AWS_REGION || 'us-west-2';
const stack = process.env.STACK_NAME || 'hearthhandoff';
const aws = (args: string[]) => execFileSync('aws', [...args, '--region', region], { encoding: 'utf8' }).trim();

const fn = aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue", '--output', 'text']);
aws(['lambda', 'update-function-configuration', '--function-name', fn, '--description', `secrets reloaded ${new Date().toISOString()}`, '--query', 'LastUpdateStatus', '--output', 'text']);
aws(['lambda', 'wait', 'function-updated-v2', '--function-name', fn]);
console.log(`Recycled ${fn}; the next request reads the current secret values.`);
