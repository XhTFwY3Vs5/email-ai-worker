const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { stdin, stdout } = require('process');

const devVarsPath = path.join(__dirname, '.dev.vars');

if (!fs.existsSync(devVarsPath)) {
    console.error('Error: .dev.vars file not found');
    process.exit(1);
}

const content = fs.readFileSync(devVarsPath, 'utf-8');
const lines = content.split('\n');

console.log('Reading secrets from .dev.vars...\n');

for (const line of lines) {
    const trimmed = line.trim();
    
    if (!trimmed || trimmed.startsWith('#')) {
        continue;
    }
    
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
        continue;
    }
    
    const key = trimmed.substring(0, equalIndex).trim();
    const value = trimmed.substring(equalIndex + 1).trim();
    
    if (!key || !value) {
        continue;
    }
    
    console.log(`Setting secret: ${key}`);
    try {
        // wrangler secret put reads from stdin
        const input = value + '\n';
        execSync(`npx wrangler secret put ${key}`, {
            input,
            cwd: __dirname,
            stdio: ['pipe', 'inherit', 'inherit']
        });
    } catch (error) {
        console.error(`Failed to set ${key}`);
    }
}

console.log('\nDone! All secrets deployed to Cloudflare.');
