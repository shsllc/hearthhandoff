// Deploys HearthHandoff to AWS with only the AWS CLI (no SAM CLI needed; CloudFormation runs the SAM transform).
//   AWS_PROFILE=<profile> npm run deploy:aws                   # first deploy (two passes to learn the Function URL)
//   AWS_PROFILE=<profile> SES_FROM=you@example.com npm run deploy:aws
// Never prints secret values.
import { execFileSync } from 'node:child_process';

const region = process.env.AWS_REGION || 'us-west-2';
const stack = process.env.STACK_NAME || 'hearthhandoff';
const sesFrom = process.env.SES_FROM || '';
const demoMode = process.env.DEMO_MODE || 'true';
const customDomain = process.env.CUSTOM_DOMAIN || '';
const certificateArn = process.env.CERTIFICATE_ARN || '';
if (customDomain && !certificateArn) throw new Error('CUSTOM_DOMAIN needs CERTIFICATE_ARN (an ISSUED ACM certificate in this region).');

const aws = (args: string[], quiet = false) =>
  execFileSync('aws', [...args, '--region', region], { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] }).trim();

const account = JSON.parse(aws(['sts', 'get-caller-identity', '--output', 'json'])).Account as string;
const bucket = `${stack}-artifacts-${account}-${region}`;
try {
  aws(['s3api', 'head-bucket', '--bucket', bucket], true);
} catch {
  console.log(`Creating artifact bucket ${bucket}`);
  aws(['s3', 'mb', `s3://${bucket}`]);
  aws(['s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration',
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true']);
}

console.log('Building Lambda bundle…');
execFileSync(process.execPath, ['scripts/build-lambda.ts'], { stdio: 'inherit' });

aws(['cloudformation', 'package', '--template-file', 'infra/template.yaml', '--s3-bucket', bucket, '--output-template-file', 'dist/packaged.yaml']);

const outputs = (): Record<string, string> => {
  try {
    const r = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json'], true));
    return Object.fromEntries((r.Stacks[0].Outputs ?? []).map((o: any) => [o.OutputKey, o.OutputValue]));
  } catch {
    return {};
  }
};

const deploy = (publicBaseUrl: string) => {
  console.log(`Deploying stack ${stack} (PublicBaseUrl=${publicBaseUrl || '(pending)'})…`);
  aws(['cloudformation', 'deploy', '--template-file', 'dist/packaged.yaml', '--stack-name', stack,
    '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND', '--no-fail-on-empty-changeset',
    '--parameter-overrides', `PublicBaseUrl=${publicBaseUrl}`, `SesFromAddress=${sesFrom}`, `DemoMode=${demoMode}`,
    `CustomDomain=${customDomain}`, `CertificateArn=${certificateArn}`]);
};

let url = customDomain ? `https://${customDomain}` : (outputs().FunctionUrl ?? '').replace(/\/$/, '');
deploy(url);
if (!url) {
  url = (outputs().FunctionUrl ?? '').replace(/\/$/, '');
  deploy(url); // second pass now that the Function URL exists
}

const o = outputs();
console.log(`
Deployed.
  App:            ${url}
  Table:          ${o.TableName}
  Secret:         ${o.SecretArn}   (add Ring credentials in the Secrets Manager console)

${customDomain ? `DNS (Cloudflare, DNS only): CNAME ${customDomain} → ${o.RegionalDomainTarget}
` : ''}
Register these on the Ring app's Account linking page (Staging tab):
  Account Link URL       ${url}/ring/link
  Token Exchange URL     ${url}/ring/token-exchange
  Webhook URL            ${url}/ring/webhook
  App Homepage URL       ${url}/
  Default Redirect URL   ${url}/

Seed the demo household into DynamoDB:
  STORE=dynamodb TABLE_NAME=${o.TableName} AWS_REGION=${region} npm run seed`);
