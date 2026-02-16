#!/bin/bash
# Deploy secrets from .dev.vars to Cloudflare

if [ ! -f .dev.vars ]; then
    echo "Error: .dev.vars file not found"
    exit 1
fi

echo "Reading secrets from .dev.vars..."

while IFS='=' read -r key value; do
    # Skip empty lines and comments
    [[ -z "$key" ]] && continue
    [[ "$key" =~ ^# ]] && continue
    
    # Trim whitespace
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    
    if [[ -n "$key" ]] && [[ -n "$value" ]]; then
        echo "Setting secret: $key"
        npx wrangler secret put "$key" --value "$value"
    fi
done < .dev.vars

echo "Done! All secrets deployed to Cloudflare."
